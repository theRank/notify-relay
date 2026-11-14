import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Level } from '../src/core/message'
import { telegram } from '../src/outbound/telegram'

const TOKEN = '123456789:AAHsecret-token_value'
const params = { TOKEN, CHAT: '987654321' }
const API = `https://api.telegram.org/bot${TOKEN}`

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): never => {
        throw new Error('telegram does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_000, signal: new AbortController().signal, channel: 'ops' } }
}

const ok = () => Response.json({ ok: true, result: { message_id: 1, chat: { id: 987654321, type: 'private' }, date: 1760000000 } })
// Telegram's own server sets the status to error_code; a proxy may answer 200 instead
const refused = (code: number, description: string, status = code) => Response.json({ ok: false, error_code: code, description }, { status })

const failure = async (response: Response, extra: object = {}) => {
    const { requests, ctx } = capture(response)
    const error = await telegram.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, ...extra }, ctx).catch((e: unknown) => e)
    return { error, requests }
}

describe('telegram', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(telegram.type).toBe('telegram')
        expect([...telegram.params]).toEqual(['TOKEN', 'CHAT'])
        expect([...(telegram.optional ?? [])]).toEqual(['THREAD', 'SERVER'])
    })

    it('sends the title in bold and the text below it, as a message any client shows', async () => {
        const { requests, ctx } = capture(ok())
        await telegram.send({ source: 'github', title: 'deploy done', text: 'all green\nin 3 minutes', level: 'normal' }, params, ctx)

        expect(requests).toHaveLength(1)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        expect(request.url).toBe(`${API}/sendMessage`)
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(await request.json()).toEqual({
            chat_id: '987654321',
            text: '<b>deploy done</b>\nall green\nin 3 minutes',
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
        })
    })

    it('sends a lone title alone', async () => {
        const { requests, ctx } = capture(ok())
        await telegram.send({ source: 'github', title: 'deploy done', level: 'normal', key: 'k', group: 'g' }, params, ctx)
        const body = (await requests[0]!.json()) as { text: string }
        expect(body.text).toBe('<b>deploy done</b>')
    })

    it('links the title to the url', async () => {
        const { requests, ctx } = capture(ok())
        await telegram.send({ source: 'github', title: 'deploy done', level: 'normal', url: 'https://example.com/run?a=1&b=2' }, params, ctx)
        const body = (await requests[0]!.json()) as { text: string }
        expect(body.text).toBe('<b><a href="https://example.com/run?a=1&amp;b=2">deploy done</a></b>')
    })

    it('escapes what HTML would take as markup, and nothing else, so the title and text show as written', async () => {
        const { requests, ctx } = capture(ok())
        await telegram.send(
            { source: 'github', title: 'a <b> & "c" *d* _e_ $f$', text: 'x < y && z > 1, `g` \\h', level: 'normal', url: 'https://example.com/?q="1"' },
            params,
            ctx,
        )
        const body = (await requests[0]!.json()) as { text: string }
        expect(body.text).toBe(
            '<b><a href="https://example.com/?q=&quot;1&quot;">a &lt;b&gt; &amp; "c" *d* _e_ $f$</a></b>\nx &lt; y &amp;&amp; z &gt; 1, `g` \\h',
        )
    })

    it("sends rich as a rich message's Markdown, after the title, in place of the text", async () => {
        const { requests, ctx } = capture(ok())
        const rich = '**all** green\n\n| job | took |\n|---|---|\n| build | 3m |\n\nprice \\$5'
        await telegram.send({ source: 'github', title: 'deploy done', text: 'all green', rich, level: 'normal' }, params, ctx)

        const request = requests[0]!
        expect(request.url).toBe(`${API}/sendRichMessage`)
        expect(await request.json()).toEqual({
            chat_id: '987654321',
            rich_message: { markdown: `<p><b>deploy done</b></p>\n\n${rich}` },
        })
    })

    // Markdown is not parsed within a block HTML tag, so the title needs only HTML's escapes
    it('keeps the title of a rich message out of the Markdown, linked to the url', async () => {
        const { requests, ctx } = capture(ok())
        await telegram.send(
            { source: 'github', title: '<x> & *y* $5 to $10', rich: 'body', level: 'normal', url: 'https://example.com/run?a=1&b=2' },
            params,
            ctx,
        )
        const { rich_message } = (await requests[0]!.json()) as { rich_message: { markdown: string } }
        expect(rich_message.markdown).toBe('<p><b><a href="https://example.com/run?a=1&amp;b=2">&lt;x&gt; &amp; *y* $5 to $10</a></b></p>\n\nbody')
    })

    it.each<[Level, boolean]>([
        ['low', true],
        ['normal', false],
        ['high', false],
        ['critical', false],
    ])('sends a %s message silently: %s', async (level, silent) => {
        for (const rich of [undefined, 'body']) {
            const { requests, ctx } = capture(ok())
            await telegram.send({ source: 'github', title: 'x', level, ...(rich && { rich }) }, params, ctx)
            const body = (await requests[0]!.json()) as object
            if (silent) expect(body).toHaveProperty('disable_notification', true)
            else expect(body).not.toHaveProperty('disable_notification')
        }
    })

    it('sends into the topic THREAD names, as a number', async () => {
        for (const rich of [undefined, 'body']) {
            const { requests, ctx } = capture(ok())
            await telegram.send({ source: 'github', title: 'x', level: 'normal', ...(rich && { rich }) }, { ...params, THREAD: '42' }, ctx)
            expect(await requests[0]!.json()).toHaveProperty('message_thread_id', 42)
        }
    })

    it.each(['general', '4.2', '-1', '0'])('fails without sending when THREAD is %j, not a topic ID', async (THREAD) => {
        const { error, requests } = await failure(ok(), { THREAD })
        expect((error as Error).message).toBe('THREAD must be a topic ID')
        expect(requests).toHaveLength(0)
    })

    it.each([
        ['https://tg.example.com', 'https://tg.example.com'],
        ['https://tg.example.com/', 'https://tg.example.com'],
        ['https://example.com/telegram/', 'https://example.com/telegram'],
        ['http://localhost:8081', 'http://localhost:8081'],
    ])('sends through SERVER %s in place of api.telegram.org', async (SERVER, base) => {
        const { requests, ctx } = capture(ok())
        await telegram.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, SERVER }, ctx)
        expect(requests[0]!.url).toBe(`${base}/bot${TOKEN}/sendMessage`)
    })

    it.each(['api.telegram.org', 'ftp://tg.example.com', 'https://'])('fails without sending, or naming the token, when SERVER is %s', async (SERVER) => {
        const { error, requests } = await failure(ok(), { SERVER })
        expect((error as Error).message).toBe('SERVER must be an http(s) URL')
        expect(requests).toHaveLength(0)
    })

    // fetch refuses a URL with credentials and names it whole, the proxy's password as well
    it('fails without sending, or naming the token, when SERVER holds a user or password', async () => {
        for (const SERVER of ['https://user:pass@tg.example.com', 'https://user@tg.example.com']) {
            const { error, requests } = await failure(ok(), { SERVER })
            expect((error as Error).message).toBe('SERVER must not hold a user or password')
            expect(requests).toHaveLength(0)
        }
    })

    it.each([
        [400, 'Bad Request: chat not found', 'HTTP 400 (chat not found)'],
        [400, 'Bad Request: message thread not found', 'HTTP 400 (message thread not found)'],
        [400, 'Bad Request: message is too long', 'HTTP 400 (message is too long)'],
        [400, 'Bad Request: RICH_MESSAGE_TEXT_TOO_LONG', 'HTTP 400 (RICH_MESSAGE_TEXT_TOO_LONG)'],
        [403, 'Forbidden: bot was blocked by the user', 'HTTP 403 (bot was blocked by the user)'],
        [401, 'Unauthorized', 'HTTP 401 (Unauthorized)'],
    ])('reports a refused message by its code and Telegram’s reason: %i %s', async (code, description, expected) => {
        for (const status of [code, 200]) {
            const { error } = await failure(refused(code, description, status))
            expect((error as Error).message).toBe(expected)
        }
    })

    it.each([
        ['without error_code, by the status', { ok: false, description: 'Bad Request: chat not found' }, 400, 'HTTP 400 (chat not found)'],
        ['without a reason, by its code', { ok: false, error_code: 403 }, 403, 'HTTP 403'],
        ['without a reason, on 200, by its code', { ok: false, error_code: 403 }, 200, 'HTTP 403'],
    ])('reports a refused message %s', async (_, answer, status, expected) => {
        const { error } = await failure(Response.json(answer, { status }))
        expect((error as Error).message).toBe(expected)
    })

    it('cuts a reason that runs long', async () => {
        const { error } = await failure(refused(400, `Bad Request: ${'x'.repeat(300)}`))
        expect((error as Error).message).toBe(`HTTP 400 (${'x'.repeat(100)}…)`)
    })

    it('reports an error status without a reason by status', async () => {
        const { error } = await failure(new Response('<html>bad gateway</html>', { status: 502 }))
        expect((error as Error).message).toBe('HTTP 502')
    })

    it('turns 429 into a rate limit with the delay asked for', async () => {
        const answer = Response.json(
            { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } },
            { status: 429, headers: { 'retry-after': '2' } },
        )
        const { error } = await failure(answer)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(2000)
    })

    // Telegram's own server sends both, but a proxy may drop the header
    it.each([
        ['the answer’s retry_after, without a Retry-After header', { retry_after: 1 }, {}, 1000],
        ['Retry-After, without a retry_after', {}, { 'retry-after': '2' }, 2000],
        ['no delay at all, as one too long to wait for', {}, {}, Infinity],
        ['no delay at all, when retry_after is not a number of seconds', { retry_after: '1' }, {}, Infinity],
    ])('turns 429 into a rate limit with %s', async (_, parameters, headers, delay) => {
        for (const status of [429, 200]) {
            const answer = Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters }, { status, headers })
            const { error } = await failure(answer)
            expect(error).toBeInstanceOf(RateLimited)
            expect((error as RateLimited).retryAfterMs).toBe(delay)
        }
    })

    // A SERVER that is not Telegram's, such as a misconfigured proxy, may answer 200 for anything
    it.each([
        ['a page', () => new Response('<html>ok</html>', { status: 200 })],
        ['JSON without ok', () => Response.json({ result: {} })],
    ])('fails on a success status whose answer is %s, not Telegram’s', async (_, response) => {
        const { error } = await failure(response())
        expect((error as Error).message).toBe('unexpected answer')
    })
})
