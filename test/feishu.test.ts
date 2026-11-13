import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Level } from '../src/core/message'
import { feishu } from '../src/outbound/feishu'

const params = { URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret' }

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): never => {
        throw new Error('feishu does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_000, signal: new AbortController().signal, channel: 'ops' } }
}

const answer = (code: number, msg: string, status = 200) => Response.json({ code, data: {}, msg }, { status })
const ok = () => Response.json({ StatusCode: 0, StatusMessage: 'success', code: 0, data: {}, msg: 'success' })

const failure = async (response: Response, extra: object = {}) => {
    const { ctx } = capture(response)
    return feishu.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, ...extra }, ctx).catch((e: unknown) => e)
}

describe('feishu', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(feishu.type).toBe('feishu')
        expect([...feishu.params]).toEqual(['URL'])
        expect([...(feishu.optional ?? [])]).toEqual(['SECRET'])
    })

    it('posts a card with the title as its header, the text as plain text and the url as its link', async () => {
        const { requests, ctx } = capture(ok())
        await feishu.send(
            { source: 'github', title: 'deploy done', text: 'all green\nin 3 minutes', level: 'normal', url: 'https://example.com/run' },
            params,
            ctx,
        )

        expect(requests).toHaveLength(1)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        expect(request.url).toBe(params.URL)
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(await request.json()).toEqual({
            msg_type: 'interactive',
            card: {
                schema: '2.0',
                config: { summary: { content: 'deploy done' } },
                card_link: { url: 'https://example.com/run' },
                header: { title: { tag: 'plain_text', content: 'deploy done' }, template: 'blue' },
                body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'all green\nin 3 minutes' } }] },
            },
        })
    })

    it("shows rich as the card's Markdown in place of the text, as written", async () => {
        const { requests, ctx } = capture(ok())
        await feishu.send(
            { source: 'github', title: 'deploy done', text: 'all green', rich: '**all** green <at id=all></at>', level: 'normal' },
            params,
            ctx,
        )
        const { card } = (await requests[0]!.json()) as { card: { body: unknown } }
        expect(card.body).toEqual({ elements: [{ tag: 'markdown', content: '**all** green <at id=all></at>' }] })
    })

    it('posts a lone title as a header only', async () => {
        const { requests, ctx } = capture(ok())
        await feishu.send({ source: 'github', title: 'deploy done', level: 'normal' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({
            msg_type: 'interactive',
            card: {
                schema: '2.0',
                config: { summary: { content: 'deploy done' } },
                header: { title: { tag: 'plain_text', content: 'deploy done' }, template: 'blue' },
            },
        })
    })

    it.each<[Level, string]>([
        ['low', 'grey'],
        ['normal', 'blue'],
        ['high', 'orange'],
        ['critical', 'red'],
    ])('colours the header of a %s message %s', async (level, template) => {
        const { requests, ctx } = capture(ok())
        await feishu.send({ source: 'github', title: 'x', level, key: 'k', group: 'g' }, params, ctx)
        const { card } = (await requests[0]!.json()) as { card: object }
        expect(card).toEqual({
            schema: '2.0',
            config: { summary: { content: 'x' } },
            header: { title: { tag: 'plain_text', content: 'x' }, template },
        })
    })

    it('signs the post with the secret, as a bot with signature verification requires', async () => {
        const { requests, ctx } = capture(ok())
        await feishu.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, SECRET: 's3cr3t' }, ctx)
        const body = (await requests[0]!.json()) as Record<string, unknown>
        // Base64 of HMAC-SHA256 keyed with "1760000000\ns3cr3t" over nothing, computed apart
        expect(body.timestamp).toBe('1760000000')
        expect(body.sign).toBe('gB0yMJ+VhyRmerSJA4SqwegORV/FV5YiabwGpgdHt7A=')
        expect(body.msg_type).toBe('interactive')
    })

    it('sends no signature without a secret', async () => {
        const { requests, ctx } = capture(ok())
        await feishu.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx)
        const body = (await requests[0]!.json()) as object
        expect(body).not.toHaveProperty('timestamp')
        expect(body).not.toHaveProperty('sign')
    })

    // Feishu answers 200 for a post it refused, with the reason in code
    it.each([
        [19021, 'sign match fail or timestamp is not within one hour from current time'],
        [19022, 'ip not allowed'],
        [19024, 'Key Words Not Found'],
        [9499, 'Bad Request'],
    ])('reports code %i, though the status is 200, without the server text', async (code, msg) => {
        const error = await failure(answer(code, msg))
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(`code ${code}`)
    })

    it('reports the code of a refused post that also has an error status', async () => {
        const error = await failure(answer(9499, 'Bad Request', 400))
        expect((error as Error).message).toBe('code 9499')
    })

    it('reports an error status without a code by status', async () => {
        const error = await failure(new Response('<html>bad gateway</html>', { status: 502 }))
        expect((error as Error).message).toBe('HTTP 502')
    })

    it('turns code 11232 into a rate limit, retried once after a second', async () => {
        const error = await failure(answer(11232, 'frequency limited'))
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(1000)
    })

    it('turns 429 into a rate limit with the delay asked for', async () => {
        const error = await failure(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(2000)
    })

    it('fails on a success status whose answer is not Feishu’s', async () => {
        const error = await failure(new Response('ok', { status: 200 }))
        expect((error as Error).message).toBe('unexpected answer')
    })
})
