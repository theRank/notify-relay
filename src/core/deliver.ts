import type { Channel } from './channels'
import { RateLimited } from './http'
import type { Message } from './message'
import type { Route } from './query'

// Matches the Cloudflare socket methods SMTP needs, without a runtime dependency.
export interface Connection {
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    startTls(): Connection
    close(): Promise<void>
}

export type Connect = (
    address: { hostname: string; port: number },
    options: { secureTransport: 'on' | 'starttls'; allowHalfOpen: boolean },
) => Connection

export interface SendContext {
    fetch: typeof fetch
    connect: Connect
    now: () => number
    signal: AbortSignal
    channel: string
}

export interface Outbound {
    type: string
    params: readonly string[]
    optional?: readonly string[]
    recipients?: (value: string, params: Record<string, string>) => string | undefined
    send(message: Message, params: Record<string, string>, ctx: SendContext): Promise<void>
}

export interface Deps {
    channels: Map<string, Channel>
    fetch: typeof fetch
    connect: Connect
    now: () => number
    sleep: (ms: number) => Promise<void>
    timeoutMs?: number
}

export interface Outcome {
    ok: boolean
    delivered: string[]
    failed: { channel: string; error: string }[]
}

const TIMEOUT_MS = 5000
const MAX_WAIT_MS = 2000

export async function deliver(message: Message, route: Route, deps: Deps): Promise<Outcome> {
    const delivered: string[] = []
    const failed: Outcome['failed'] = []
    const record = (channel: string, error: string | undefined) => {
        if (error === undefined) delivered.push(channel)
        else failed.push({ channel, error })
    }

    // Copies run concurrently but must not affect success or delay fallback attempts.
    const copies = Promise.all(route.also.map((channel) => attempt(message, channel, deps)))
    const errors = await Promise.all(route.channels.map((channel) => attempt(message, channel, deps)))
    route.channels.forEach((channel, i) => record(channel, errors[i]))

    if (delivered.length === 0) {
        for (const channel of route.fallback) {
            const error = await attempt(message, channel, deps)
            record(channel, error)
            if (error === undefined) break
        }
    }
    const ok = delivered.length > 0

    const copied = await copies
    route.also.forEach((channel, i) => record(channel, copied[i]))
    return { ok, delivered, failed }
}

async function attempt(message: Message, name: string, deps: Deps): Promise<string | undefined> {
    const channel = deps.channels.get(name)
    if (!channel) return 'unknown channel'
    const { adapter, params, missing } = channel
    if (!adapter) return `unknown type '${channel.type}'`
    if (missing.length > 0) return `missing ${missing.join(', ')}`
    for (let retried = false; ; retried = true) {
        try {
            await withTimeout(
                (signal) => adapter.send(message, params, { fetch: deps.fetch, connect: deps.connect, now: deps.now, signal, channel: name }),
                deps.timeoutMs ?? TIMEOUT_MS,
            )
            return undefined
        } catch (error) {
            if (error instanceof RateLimited && !retried && error.retryAfterMs <= MAX_WAIT_MS) {
                await deps.sleep(error.retryAfterMs)
                continue
            }
            return redact(reason(error), params)
        }
    }
}

// Races the work instead of trusting the adapter to honour the signal
async function withTimeout(work: (signal: AbortSignal) => Promise<void>, ms: number): Promise<void> {
    const controller = new AbortController()
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new DOMException('timeout', 'TimeoutError')
            controller.abort(error)
            reject(error)
        }, ms)
    })
    try {
        await Promise.race([work(controller.signal), timeout])
    } finally {
        clearTimeout(timer)
    }
}

function reason(error: unknown): string {
    if (error instanceof RateLimited) return 'rate limited'
    if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout'
    if (error instanceof Error) return error.message
    return 'failed'
}

// Errors may expose settings. Short values are excluded to avoid redacting unrelated numbers or words.
const MIN_REDACTED = 8

function redact(text: string, params: Record<string, string>): string {
    const forms = Object.values(params)
        .filter((value) => value.length >= MIN_REDACTED)
        .flatMap((value) => [value, encodeURIComponent(value), ...(URL.canParse(value) ? [new URL(value).href] : [])])
    if (forms.length === 0) return text
    // Match longer settings first; one pass avoids redacting replacement text.
    const pattern = [...new Set(forms)]
        .sort((a, b) => b.length - a.length)
        .map((form) => form.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&'))
        .join('|')
    return text.replace(new RegExp(pattern, 'g'), '<redacted>')
}
