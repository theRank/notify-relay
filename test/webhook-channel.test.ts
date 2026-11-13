import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Message } from '../src/core/message'
import { signature, webhook } from '../src/outbound/webhook'

const params = { URL: 'https://hooks.example.com/notify?token=abc' }
// 24 bytes, the shortest secret Standard Webhooks allows
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'

function capture(response: () => Response = () => new Response(null, { status: 204 })) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response()
    }
    const connect = (): never => {
        throw new Error('webhook does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_500, signal: new AbortController().signal, channel: 'hook' } }
}

const message: Message = { source: 'github', title: 'x', level: 'normal' }

const failure = async (response: Response, extra: object = {}) => {
    const { ctx } = capture(() => response)
    return webhook.send(message, { ...params, ...extra }, ctx).catch((e: unknown) => e)
}

describe('webhook', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(webhook.type).toBe('webhook')
        expect([...webhook.params]).toEqual(['URL'])
        expect([...(webhook.optional ?? [])]).toEqual(['SECRET', 'TOKEN'])
    })

    it('posts the message as JSON, with every field but the recipients of other channels', async () => {
        const { requests, ctx } = capture()
        await webhook.send(
            {
                source: 'github',
                title: 'deploy done',
                text: 'all green',
                rich: '**all** green',
                level: 'high',
                url: 'https://example.com/run',
                key: 'deploy-1',
                group: 'ci',
                to: { mail: 'ops@example.com' },
            },
            params,
            ctx,
        )

        expect(requests).toHaveLength(1)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        expect(request.url).toBe(params.URL)
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(request.headers.has('authorization')).toBe(false)
        expect([...request.headers.keys()].filter((name) => name.startsWith('webhook-'))).toEqual([])
        expect(await request.json()).toEqual({
            source: 'github',
            title: 'deploy done',
            text: 'all green',
            rich: '**all** green',
            level: 'high',
            url: 'https://example.com/run',
            key: 'deploy-1',
            group: 'ci',
        })
    })

    it('leaves out the fields the message does not have', async () => {
        const { requests, ctx } = capture()
        await webhook.send(message, params, ctx)
        expect(await requests[0]!.text()).toBe('{"source":"github","title":"x","level":"normal"}')
    })

    it('sends a token as a bearer token', async () => {
        const { requests, ctx } = capture()
        await webhook.send(message, { ...params, TOKEN: 's3cr3t' }, ctx)
        expect(requests[0]!.headers.get('authorization')).toBe('Bearer s3cr3t')
    })

    it('signs the post as Standard Webhooks does, with an ID of its own for each post', async () => {
        const { requests, ctx } = capture()
        await webhook.send(message, { ...params, SECRET }, ctx)
        await webhook.send(message, { ...params, SECRET }, ctx)

        const [first, second] = requests.map((request) => request.headers)
        expect(first!.get('webhook-id')).toMatch(/^msg_[0-9a-f]{32}$/)
        expect(second!.get('webhook-id')).not.toBe(first!.get('webhook-id'))
        expect(first!.get('webhook-timestamp')).toBe('1760000000')
        const body = await requests[0]!.text()
        expect(first!.get('webhook-signature')).toBe(await signature(SECRET, first!.get('webhook-id')!, 1_760_000_000, body))
    })

    // The example in the tests of the Standard Webhooks libraries
    it.each([
        ['with', SECRET],
        ['without', SECRET.slice('whsec_'.length)],
    ])('signs as the Standard Webhooks libraries do, %s the whsec_ prefix', async (_, secret) => {
        expect(await signature(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1_614_265_330, '{"test": 2432232314}')).toBe(
            'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
        )
    })

    it.each([
        ['not base64', 'whsec_not base64!', 'SECRET must be base64'],
        ['shorter than 24 bytes', `whsec_${btoa('x'.repeat(23))}`, 'SECRET must be at least 24 bytes'],
    ])('refuses a secret %s, without posting', async (_, secret, reason) => {
        const { requests, ctx } = capture()
        const error = await webhook.send(message, { ...params, SECRET: secret }, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe(reason)
        expect(requests).toHaveLength(0)
    })

    it.each([200, 202, 204])('takes %i as delivered', async (status) => {
        const { ctx } = capture(() => new Response(null, { status }))
        await expect(webhook.send(message, params, ctx)).resolves.toBeUndefined()
    })

    it.each([301, 302, 307, 308])('fails on a %i instead of following it', async (status) => {
        const { requests, ctx } = capture(() => new Response(null, { status, headers: { location: 'https://example.com/' } }))
        const error = await webhook.send(message, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe(`HTTP ${status}`)
        expect(requests[0]!.redirect).toBe('manual')
    })

    it.each([400, 404, 500])('reports a refused post by status, without the server text', async (status) => {
        const error = await failure(new Response('no such hook', { status }))
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(`HTTP ${status}`)
    })

    it('turns 429 into a rate limit with the delay the receiver asks for', async () => {
        const error = await failure(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(2000)
    })
})
