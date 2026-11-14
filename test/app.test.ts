import { describe, expect, it } from 'vitest'
import { handle } from '../src/app'
import { parseMail, utf8 } from './mail'

const env = {
    CHANNEL_LOKI_TYPE: 'loki',
    CHANNEL_LOKI_URL: 'https://logs.example/loki/api/v1/push',
    CHANNEL_LOKI_USER: '123456',
    CHANNEL_LOKI_TOKEN: 'glc_secret',
    TOKEN_GITHUB: 'nr_github',
}

function setup(lokiStatus = 204, overrides: Record<string, string | undefined> = {}) {
    const pushed: unknown[] = []
    const urls: string[] = []
    const deps = {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            urls.push(request.url)
            pushed.push(await request.json())
            return new Response(null, { status: lokiStatus })
        },
        connect: (): never => {
            throw new Error('loki does not connect')
        },
        now: () => 1_760_000_000_000,
        sleep: async () => {},
    }
    const send = (path: string, init: RequestInit = {}) =>
        handle(new Request(`https://notify.example${path}`, init), { ...env, ...overrides }, deps)
    return { pushed, urls, send }
}

const authorized = (body: unknown, token = 'nr_github'): RequestInit => ({
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
})

describe('POST /webhook', () => {
    it('delivers to Loki under the source the token belongs to', async () => {
        const { pushed, send } = setup()
        const response = await send('/webhook?channels=loki', authorized({ title: 'deploy done', level: 'low' }))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ messages: [{ delivered: ['loki'], failed: [] }] })
        expect(pushed).toEqual([
            {
                streams: [
                    {
                        stream: { job: 'notify-relay', source: 'github', level: 'low' },
                        values: [['1760000000000000000', JSON.stringify({ title: 'deploy done' })]],
                    },
                ],
            },
        ])
    })

    it('delivers to several channels of the same type, each with its own settings', async () => {
        const { urls, send } = setup(204, {
            CHANNEL_ARCHIVE_TYPE: 'loki',
            CHANNEL_ARCHIVE_URL: 'https://archive.example/loki/api/v1/push',
            CHANNEL_ARCHIVE_USER: '654321',
            CHANNEL_ARCHIVE_TOKEN: 'glc_other',
        })
        const response = await send('/webhook?channels=loki,archive', authorized({ title: 'x' }))
        expect(await response.json()).toEqual({ messages: [{ delivered: ['loki', 'archive'], failed: [] }] })
        expect(urls.sort()).toEqual(['https://archive.example/loki/api/v1/push', 'https://logs.example/loki/api/v1/push'])
    })

    it('is 502 when every channel fails, and says why without secrets', async () => {
        const { send } = setup(500)
        const response = await send('/webhook?channels=loki', authorized({ title: 'x' }))

        expect(response.status).toBe(502)
        const text = await response.text()
        expect(JSON.parse(text)).toEqual({ messages: [{ delivered: [], failed: [{ channel: 'loki', error: 'HTTP 500' }] }] })
        expect(text).not.toContain('glc_secret')
        expect(text).not.toContain('nr_github')
    })

    it('checks the token before looking at anything else', async () => {
        const { pushed, send } = setup()
        for (const init of [
            authorized({ title: 'x' }, 'nr_wrong'),
            { method: 'POST', body: JSON.stringify({ title: 'x' }) },
            authorized({ titel: 'not even valid' }, 'nr_wrong'),
        ]) {
            const response = await send('/webhook', init)
            expect(response.status).toBe(401)
            expect(await response.text()).toBe('')
        }
        expect(pushed).toEqual([])
    })

    it('rejects bad requests with the reason', async () => {
        const { pushed, send } = setup()
        const cases: [string, RequestInit, string][] = [
            ['/webhook', authorized({ title: 'x' }), 'channels is required'],
            ['/webhook?channels=pager', authorized({ title: 'x' }), "unknown channel 'pager'"],
            ['/webhook?channels=loki', authorized({ titel: 'x' }), "unknown field 'titel'"],
            [
                '/webhook?channels=loki',
                { ...authorized(null), body: '{"title":' },
                'body must be valid JSON',
            ],
            ['/webhook?channels=loki', { ...authorized(null), body: null }, 'body must be valid JSON'],
        ]
        for (const [path, init, reason] of cases) {
            const response = await send(path, init)
            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({ error: reason })
        }
        expect(pushed).toEqual([])
    })

    it('refuses bodies over 64 KB, whatever Content-Length says', async () => {
        const { pushed, send } = setup()
        const big = JSON.stringify({ title: 'x', text: 'a'.repeat(64 * 1024) })
        for (const headers of [{ authorization: 'Bearer nr_github' }, { authorization: 'Bearer nr_github', 'content-length': '10' }]) {
            const response = await send('/webhook?channels=loki', { method: 'POST', headers, body: big })
            expect(response.status).toBe(413)
        }
        expect(pushed).toEqual([])
    })

    it('refuses a declared Content-Length over 64 KB without reading the body', async () => {
        const { send } = setup()
        // Node requires duplex for a streamed body, and Workers' RequestInit does not declare it
        const init = {
            method: 'POST',
            headers: { authorization: 'Bearer nr_github', 'content-length': String(64 * 1024 + 1) },
            body: new ReadableStream({ pull: () => new Promise<void>(() => {}) }),
            duplex: 'half',
        }
        const response = await send('/webhook?channels=loki', init)
        expect(response.status).toBe(413)
    })

    it('only takes POST', async () => {
        const { send } = setup()
        const response = await send('/webhook?channels=loki', { method: 'GET' })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('POST')
    })
})

describe('recipients a message names in to', () => {
    const TOKEN_URL = 'https://oauth2.googleapis.com/token'
    const mail = (name: string, to: string) => ({
        [`CHANNEL_${name}_TYPE`]: 'gmail',
        [`CHANNEL_${name}_CLIENT_ID`]: 'client.apps.example',
        [`CHANNEL_${name}_CLIENT_SECRET`]: 'csecret',
        [`CHANNEL_${name}_REFRESH_TOKEN`]: 'rtoken',
        [`CHANNEL_${name}_TO`]: to,
    })

    function setup(extra: Record<string, string> = {}) {
        const requests: string[] = []
        const to: string[] = []
        const deps = {
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init)
                requests.push(request.url)
                if (request.url === TOKEN_URL) return Response.json({ access_token: 'ya29.access' })
                if (request.url.startsWith('https://gmail.googleapis.com/')) {
                    const { raw } = (await request.json()) as { raw: string }
                    to.push(parseMail(utf8(raw)).headers.to!)
                    return Response.json({ id: 'm1' })
                }
                return new Response(null, { status: 204 })
            },
            connect: (): never => {
                throw new Error('gmail does not connect')
            },
            now: () => 1_760_000_000_000,
            sleep: async () => {},
        }
        const channels = { ...env, ...mail('MAIL', 'me@example.com'), ...mail('SPARE', 'spare@example.com'), ...extra }
        const send = (path: string, body: unknown) =>
            handle(new Request(`https://notify.example${path}`, authorized(body)), channels, deps)
        return { requests, to, send }
    }

    it('sends to the recipients named for a channel whose ALLOW_TO admits them', async () => {
        const { to, send } = setup({ CHANNEL_MAIL_ALLOW_TO: '*@example.org' })
        const response = await send('/webhook?channels=mail', { title: 'x', to: { mail: 'team@example.org' } })
        expect(response.status).toBe(200)
        expect(to).toEqual(['team@example.org'])
    })

    it('keeps TO for a channel the message names no recipients for', async () => {
        const { to, send } = setup({ CHANNEL_MAIL_ALLOW_TO: '*' })
        const response = await send('/webhook?channels=mail,spare,loki', { title: 'x', to: { mail: 'team@example.org' } })
        expect(await response.json()).toEqual({ messages: [{ delivered: ['mail', 'spare', 'loki'], failed: [] }] })
        expect(to.sort()).toEqual(['spare@example.com', 'team@example.org'])
    })

    it.each([
        ['a channel this request does not send to', '/webhook?channels=loki', { mail: 'a@example.org' }, {}, "to names 'mail', which this request does not send to"],
        ['a channel whose type takes no recipients', '/webhook?channels=loki', { loki: 'a@example.org' }, {}, "'loki' does not take recipients"],
        ['recipients that are not email addresses', '/webhook?channels=mail', { mail: 'a@typo@example.org' }, { CHANNEL_MAIL_ALLOW_TO: '*' }, 'to.mail: must be one or more email addresses'],
        ['a channel without ALLOW_TO', '/webhook?channels=mail', { mail: 'a@example.org' }, {}, 'to.mail: custom recipients not enabled'],
        ['a recipient outside ALLOW_TO', '/webhook?channels=mail', { mail: 'a@example.org, spy@example.com' }, { CHANNEL_MAIL_ALLOW_TO: '*@example.org' }, 'to.mail: recipient not allowed'],
        ['a fallback channel without ALLOW_TO', '/webhook?channels=loki&fallback=mail', { mail: 'a@example.org' }, {}, 'to.mail: custom recipients not enabled'],
    ])('is a 400 for %s, before any channel is contacted', async (_, path, recipients, extra, error) => {
        const { requests, send } = setup(extra)
        const response = await send(path, { title: 'x', to: recipients })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error })
        expect(requests).toEqual([])
    })

    // Parsing runs without a pause, so nothing could cut it short
    it('refuses recipients that are mostly spaces in time that grows with their length', async () => {
        const { send } = setup({ CHANNEL_MAIL_ALLOW_TO: '*' })
        const started = performance.now()
        const response = await send('/webhook?channels=mail', { title: 'x', to: { mail: `a${' '.repeat(60_000)}b` } })
        expect(response.status).toBe(400)
        expect(performance.now() - started).toBeLessThan(1000)
    })

    it('leaves a malformed ALLOW_TO to delivery, since only the operator can fix it', async () => {
        const { requests, send } = setup({ CHANNEL_MAIL_ALLOW_TO: 'example.org' })
        const response = await send('/webhook?channels=mail', { title: 'x', to: { mail: 'a@example.org' } })
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ messages: [{ delivered: [], failed: [{ channel: 'mail', error: 'invalid ALLOW_TO' }] }] })
        expect(requests).toEqual([])
    })
})

describe('GET /healthz', () => {
    it('needs no token and touches no channel', async () => {
        const { pushed, send } = setup()
        const response = await send('/healthz')
        expect(response.status).toBe(200)
        expect(pushed).toEqual([])
    })

    it('is 503 while a configured channel is missing a parameter', async () => {
        for (const missing of ['CHANNEL_LOKI_TOKEN', 'CHANNEL_LOKI_URL']) {
            const { send } = setup(204, { [missing]: undefined })
            const response = await send('/healthz')
            expect(response.status).toBe(503)
            expect(await response.text()).toBe('not ready')
        }
    })

    it('is 503 while a channel has a type the relay does not know', async () => {
        const { send } = setup(204, { CHANNEL_PAGER_TYPE: 'pagerduty' })
        expect((await send('/healthz')).status).toBe(503)
    })

    it.each(['toString', 'constructor', '__proto__'])('is 503 while a channel has the type %s, which every object has but no adapter is', async (type) => {
        const { send } = setup(204, { CHANNEL_PAGER_TYPE: type })
        expect((await send('/healthz')).status).toBe(503)
    })

    it('answers HEAD as it does GET, without the body', async () => {
        const ready = await setup().send('/healthz', { method: 'HEAD' })
        expect(ready.status).toBe(200)
        expect(await ready.text()).toBe('')
        const missing = await setup(204, { CHANNEL_LOKI_TOKEN: undefined }).send('/healthz', { method: 'HEAD' })
        expect(missing.status).toBe(503)
        expect(await missing.text()).toBe('')
    })

    it('takes no other method', async () => {
        const response = await setup().send('/healthz', { method: 'POST' })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET, HEAD')
    })

    it('is 503 with no channel at all', async () => {
        const { send } = setup(204, { CHANNEL_LOKI_TYPE: undefined })
        expect((await send('/healthz')).status).toBe(503)
    })

    it('is 503 while no source can authenticate', async () => {
        const { send } = setup(204, { TOKEN_GITHUB: undefined })
        expect((await send('/healthz')).status).toBe(503)
    })
})
