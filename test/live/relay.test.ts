import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../../src/platforms/cloudflare'
import { arrival } from './imap'

const run = crypto.randomUUID()
const vars = env as unknown as Record<string, string>
const mailbox = { host: vars.LIVE_IMAP_HOST!, user: vars.LIVE_IMAP_USER!, password: vars.LIVE_IMAP_PASSWORD! }
const title = (channel: string) => `notify-relay live test ${run} via ${channel} on ${vars.LIVE_TARGET}`
const authorization = `Bearer ${vars.LIVE_TOKEN}`

async function call(method: string, path: string, init: RequestInit<IncomingRequestCfProperties> = {}): Promise<Response> {
    if (vars.LIVE_RELAY_URL) return fetch(new URL(path, vars.LIVE_RELAY_URL), { method, ...init })
    const request = new Request<unknown, IncomingRequestCfProperties>(`https://notify.example${path}`, { method, ...init })
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)
    return response
}

async function send(channel: string, html = false): Promise<unknown> {
    const what = `Sent through ${channel} on ${vars.LIVE_TARGET} by the live test, ${html ? 'as HTML with a plain-text alternative' : 'as plain text'}.`
    const message = {
        title: title(channel),
        text: `${what}\nCommit: ${vars.LIVE_COMMIT_URL}\nRun: ${vars.LIVE_RUN_URL}`,
        ...(html && {
            rich: `<p>${what}</p><p>Commit: <a href="${vars.LIVE_COMMIT_URL}"><code>${vars.LIVE_COMMIT}</code></a><br>Run: <a href="${vars.LIVE_RUN_URL}">${vars.LIVE_RUN_URL}</a></p>`,
        }),
    }
    const response = await call('POST', `/webhook?channels=${channel}`, {
        headers: { authorization },
        body: JSON.stringify(message),
    })
    return response.json()
}

async function readBack(): Promise<boolean> {
    const query = new URL('query_range', vars.CHANNEL_LOKI_URL)
    query.searchParams.set('query', `{job="notify-relay", source="live"} |= "${run}"`)
    query.searchParams.set('start', `${Date.now() - 10 * 60_000}000000`)
    const authorization = `Basic ${btoa(`${vars.CHANNEL_LOKI_USER}:${vars.CHANNEL_LOKI_TOKEN}`)}`
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 2000))) {
        const response = await fetch(query, { headers: { authorization } })
        expect(response.status).toBe(200)
        const { data } = (await response.json()) as { data: { result: unknown[] } }
        if (data.result.length > 0) return true
    }
    return false
}

async function received(channel: string): Promise<string[] | undefined> {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 2000))) {
        const flags = await arrival(mailbox, title(channel))
        if (flags) return flags
    }
    return undefined
}

describe('live', () => {
    it('is ready with every channel configured', async () => {
        expect((await call('GET', '/healthz')).status).toBe(200)
    })

    it('pushes to Loki, where the line can be read back', async () => {
        expect(await send('loki')).toEqual({ messages: [{ delivered: ['loki'], failed: [] }] })
        expect(await readBack()).toBe(true)
    }, 90_000)

    it('refuses a request without a token', async () => {
        const response = await call('POST', '/webhook?channels=loki', { body: JSON.stringify({ title: title('loki') }) })
        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
    })

    it('refuses a body over 64 KB', async () => {
        const response = await call('POST', '/webhook?channels=loki', { headers: { authorization }, body: 'x'.repeat(64 * 1024 + 1) })
        expect(response.status).toBe(413)
    })

    // A platform may read a body of unknown length differently from one with a Content-Length, as Azure's
    // host does, and a stream of our own has no length, so it goes out chunked
    it('takes a body sent chunked', async () => {
        const json = JSON.stringify({ title: title('loki'), text: 'Sent chunked, without a length.' })
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(json))
                controller.close()
            },
        })
        const response = await call('POST', '/webhook?channels=loki', { headers: { authorization }, body })
        expect(await response.json()).toEqual({ messages: [{ delivered: ['loki'], failed: [] }] })
    })

    it.each([
        ['smtp-587', 'plain text', false],
        ['smtp-465', 'HTML', true],
        ['gmail', 'HTML', true],
    ])('gets mail through %s as %s into the mailbox', async (channel, _, html) => {
        expect(await send(channel, html)).toEqual({ messages: [{ delivered: [channel], failed: [] }] })
        const flags = await received(channel)
        expect(flags).toBeDefined()
        if (flags!.some((flag) => flag.toLowerCase() === '\\junk')) console.warn(`${channel}: landed in junk`)
    }, 90_000)
})
