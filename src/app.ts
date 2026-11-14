import { authenticate, hasSources } from './core/auth'
import { type Channel, resolveChannels } from './core/channels'
import { type Connect, deliver, type Outcome } from './core/deliver'
import { BadRequest } from './core/http'
import type { Inbound } from './core/message'
import { parseChannels } from './core/query'
import { webhook } from './inbound/webhook'
import { adapters } from './outbound'

export interface AppDeps {
    fetch: typeof fetch
    connect: Connect
    now: () => number
    sleep: (ms: number) => Promise<void>
}

const MAX_BODY_BYTES = 64 * 1024

const inbounds: Record<string, Inbound> = { '/webhook': webhook }

// Token first: an unauthenticated caller learns nothing from validation and never has its body read
export async function handle(request: Request, env: object, deps: AppDeps): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
        const answer = ready(resolveChannels(env, adapters), env) ? { body: 'ok', status: 200 } : { body: 'not ready', status: 503 }
        return new Response(request.method === 'HEAD' ? null : answer.body, { status: answer.status })
    }

    const inbound = inbounds[url.pathname]
    if (!inbound) return new Response(null, { status: 404 })
    if (request.method !== 'POST') return methodNotAllowed('POST')

    const source = authenticate(request.headers.get('authorization'), env)
    if (!source) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } })

    const channels = resolveChannels(env, adapters)
    const routing = parseChannels(url, [...channels.keys()])
    if ('error' in routing) return badRequest(routing.error)

    const raw = await readBody(request)
    if (raw === undefined) return new Response(null, { status: 413 })

    let drafts
    try {
        drafts = inbound.parse(parseJson(raw))
    } catch (error) {
        if (error instanceof BadRequest) return badRequest(error.message)
        throw error
    }
    if (drafts.length === 0) return new Response(null, { status: 204 })
    for (const draft of drafts) {
        const refused = refuseRecipients(draft.to ?? {}, [...routing.channels, ...routing.fallback], channels)
        if (refused !== undefined) return badRequest(refused)
    }

    const outcomes: Outcome[] = []
    for (const draft of drafts) {
        outcomes.push(await deliver({ ...draft, source }, routing.channels, routing.fallback, { ...deps, channels }))
    }
    return Response.json(
        { messages: outcomes.map(({ delivered, failed }) => ({ delivered, failed })) },
        { status: outcomes.every((outcome) => outcome.ok) ? 200 : 502 },
    )
}

function ready(channels: Map<string, Channel>, env: object): boolean {
    const configured = [...channels.values()]
    const complete = configured.every((channel) => channel.adapter !== undefined && channel.missing.length === 0)
    return configured.length > 0 && complete && hasSources(env)
}

// Content-Length is not trusted
async function readBody(request: Request): Promise<string | undefined> {
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return undefined
    if (!request.body) return ''
    const reader = request.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    let text = ''
    for (;;) {
        const { done, value } = await reader.read()
        if (done) return text + decoder.decode()
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
            await reader.cancel()
            return undefined
        }
        text += decoder.decode(value, { stream: true })
    }
}

function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw)
    } catch {
        throw new BadRequest('body must be valid JSON')
    }
}

function badRequest(error: string): Response {
    return Response.json({ error }, { status: 400 })
}

function methodNotAllowed(allow: string): Response {
    return new Response(null, { status: 405, headers: { allow } })
}

function refuseRecipients(to: Record<string, string>, used: string[], channels: Map<string, Channel>): string | undefined {
    for (const [name, value] of Object.entries(to)) {
        const channel = channels.get(name)
        if (!channel || !used.includes(name)) return `to names '${name}', which this request does not send to`
        const refuse = channel.adapter?.recipients
        if (!refuse) return `'${name}' does not take recipients`
        const reason = refuse(value, channel.params)
        if (reason !== undefined) return `to.${name}: ${reason}`
    }
    return undefined
}
