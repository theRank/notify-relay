import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { keyId } from '../../src/outbound/key'
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

async function send(channel: string, html = false, fields: object = {}): Promise<unknown> {
    const what = `Sent through ${channel} on ${vars.LIVE_TARGET} by the live test, ${html ? 'as HTML with a plain-text alternative' : 'as plain text'}.`
    const message = {
        title: title(channel),
        text: `${what}\nCommit: ${vars.LIVE_COMMIT_URL}\nRun: ${vars.LIVE_RUN_URL}`,
        ...(html && {
            rich: `<p>${what}</p><p>Commit: <a href="${vars.LIVE_COMMIT_URL}"><code>${vars.LIVE_COMMIT}</code></a><br>Run: <a href="${vars.LIVE_RUN_URL}">${vars.LIVE_RUN_URL}</a></p>`,
        }),
        ...fields,
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

// The topic's cached messages, as ntfy keeps them for subscribers that poll
async function published(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
    const topic = new URL(`${vars.CHANNEL_NTFY_TOPIC}/json`, 'https://ntfy.sh/')
    topic.searchParams.set('poll', '1')
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 2000))) {
        const response = await fetch(topic)
        expect(response.status).toBe(200)
        const lines = (await response.text()).split('\n').filter((line) => line !== '')
        const found = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find(match)
        if (found) return found
    }
    return undefined
}

function parsed(text: unknown): Record<string, unknown> | undefined {
    try {
        return JSON.parse(text as string) as Record<string, unknown>
    } catch {
        return undefined
    }
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

    it('publishes to ntfy, where the message can be read back with its priority, Markdown and sequence ID', async () => {
        const key = `live-${run}`
        const rich = `Sent through **ntfy** on ${vars.LIVE_TARGET} by the live test, as Markdown.`
        expect(await send('ntfy', false, { rich, level: 'high', key })).toEqual({ messages: [{ delivered: ['ntfy'], failed: [] }] })
        expect(await published((message) => message.title === title('ntfy'))).toMatchObject({
            message: rich,
            content_type: 'text/markdown',
            priority: 4,
            sequence_id: await keyId(key),
        })
    }, 60_000)

    // The webhook posts to the ntfy topic, which keeps the body as the message
    it('posts the message as JSON to a webhook, where it can be read back as sent', async () => {
        const key = `live-${run}`
        expect(await send('webhook', false, { level: 'high', key })).toEqual({ messages: [{ delivered: ['webhook'], failed: [] }] })
        const found = await published((message) => parsed(message.message)?.title === title('webhook'))
        expect(parsed(found?.message)).toEqual({
            source: 'live',
            title: title('webhook'),
            text: expect.stringContaining(vars.LIVE_RUN_URL!),
            level: 'high',
            key,
        })
    }, 60_000)

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

    // Nothing reads a push back, so the test sees as far as the server accepting it; the phone shows the
    // rest, in a group of its own that Bark can mute
    it.skipIf(!vars.CHANNEL_BARK_TYPE)('pushes through Bark', async () => {
        expect(await send('bark', false, { group: 'notify-relay live test' })).toEqual({ messages: [{ delivered: ['bark'], failed: [] }] })
    })

    // Nothing reads the post back; the channel shows the header, the mrkdwn and the link
    it.skipIf(!vars.CHANNEL_SLACK_TYPE)('posts to Slack, with mrkdwn and a link', async () => {
        const rich = `Sent through *slack* on ${vars.LIVE_TARGET} by the live test, as _mrkdwn_.`
        const outcome = { messages: [{ delivered: ['slack'], failed: [] }] }
        expect(await send('slack', false, { rich, url: 'https://github.com/theRank/notify-relay' })).toEqual(outcome)
    })

    // Nothing reads the post back; the channel shows the embed: its title linked, the Markdown, and the
    // orange of a high message
    it.skipIf(!vars.CHANNEL_DISCORD_TYPE)('posts to Discord, as an embed with Markdown', async () => {
        const rich = `Sent through **discord** on ${vars.LIVE_TARGET} by the live test, as _Markdown_.`
        const outcome = { messages: [{ delivered: ['discord'], failed: [] }] }
        expect(await send('discord', false, { rich, level: 'high', url: 'https://github.com/theRank/notify-relay' })).toEqual(outcome)
    })

    // Nothing reads the post back; the group shows the card: its orange header, the Markdown, and the
    // link it opens. A secret, when set, signs the post, and Feishu refuses one signed wrong
    it.skipIf(!vars.CHANNEL_FEISHU_TYPE)('posts to Feishu, as a card with Markdown', async () => {
        const rich = `Sent through **feishu** on ${vars.LIVE_TARGET} by the live test, as *Markdown*.`
        const outcome = { messages: [{ delivered: ['feishu'], failed: [] }] }
        expect(await send('feishu', false, { rich, level: 'high', url: 'https://github.com/theRank/notify-relay' })).toEqual(outcome)
    })

    // Nothing reads the message back; the chat shows it: the title in bold, linked, then the text. It goes
    // as a classic message, as one without rich does
    it.skipIf(!vars.CHANNEL_TELEGRAM_TYPE)('sends to Telegram, as a classic message', async () => {
        const outcome = { messages: [{ delivered: ['telegram'], failed: [] }] }
        expect(await send('telegram', false, { level: 'high', url: 'https://github.com/theRank/notify-relay' })).toEqual(outcome)
    })

    // Nothing reads the message back; the chat shows it: the title in bold, then the Markdown and its table.
    // Low, so it arrives silently
    it.skipIf(!vars.CHANNEL_TELEGRAM_TYPE)('sends to Telegram, as a rich message with Markdown', async () => {
        const rich = [
            `Sent through **telegram** on ${vars.LIVE_TARGET} by the live test, as a _rich message_.`,
            '| Commit | Run |\n|---|---|',
            `| [${vars.LIVE_COMMIT}](${vars.LIVE_COMMIT_URL}) | [run](${vars.LIVE_RUN_URL}) |`,
        ].join('\n\n')
        const outcome = { messages: [{ delivered: ['telegram'], failed: [] }] }
        expect(await send('telegram', false, { rich, level: 'low' })).toEqual(outcome)
    })

    // Only the phone can tell whether it decrypted: it shows "Decryption Failed" otherwise
    it.skipIf(!vars.CHANNEL_BARK_SEALED_TYPE)('pushes through Bark, end-to-end encrypted', async () => {
        const outcome = { messages: [{ delivered: ['bark-sealed'], failed: [] }] }
        expect(await send('bark-sealed', false, { group: 'notify-relay live test' })).toEqual(outcome)
    })
})
