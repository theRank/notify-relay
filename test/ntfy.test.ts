import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Level } from '../src/core/message'
import { ntfy } from '../src/outbound/ntfy'

const params = { TOPIC: 'alerts-6f1c2a' }

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): never => {
        throw new Error('ntfy does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_000, signal: new AbortController().signal, channel: 'phone' } }
}

const ok = () => Response.json({ id: 'abc', event: 'message' })

describe('ntfy', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(ntfy.type).toBe('ntfy')
        expect([...ntfy.params]).toEqual(['TOPIC'])
        expect([...(ntfy.optional ?? [])]).toEqual(['SERVER', 'TOKEN'])
    })

    it('publishes every field it has a slot for as JSON to ntfy.sh', async () => {
        const { requests, ctx } = capture(ok())
        await ntfy.send(
            {
                source: 'github',
                title: 'deploy failed',
                text: 'prod is down',
                rich: '**prod** is down',
                level: 'critical',
                url: 'https://example.com/run',
                key: 'deploy:prod',
                group: 'deploys',
            },
            params,
            ctx,
        )

        expect(requests).toHaveLength(1)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        // JSON goes to the root, which keeps a title in any script out of the headers
        expect(request.url).toBe('https://ntfy.sh/')
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(request.headers.get('authorization')).toBeNull()
        expect(await request.json()).toEqual({
            topic: 'alerts-6f1c2a',
            title: 'deploy failed',
            message: '**prod** is down',
            markdown: true,
            priority: 5,
            click: 'https://example.com/run',
            // SHA-256 of the key, base64url: within the 64 characters of [-_A-Za-z0-9] ntfy allows
            sequence_id: 'nx0slVoF-Dv8R-SrmfomsE_VxTxaC9HjeRlmwzdUsks',
        })
    })

    it('publishes text as plain text', async () => {
        const { requests, ctx } = capture(ok())
        await ntfy.send({ source: 'github', title: 'deploy done', text: 'all green', level: 'normal' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ topic: 'alerts-6f1c2a', title: 'deploy done', message: 'all green', priority: 3 })
    })

    it('makes a lone title the message, which ntfy would otherwise fill with "triggered"', async () => {
        const { requests, ctx } = capture(ok())
        await ntfy.send({ source: 'github', title: 'deploy done', level: 'normal' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ topic: 'alerts-6f1c2a', message: 'deploy done', priority: 3 })
    })

    it.each<[Level, number]>([
        ['low', 2],
        ['normal', 3],
        ['high', 4],
        ['critical', 5],
    ])('publishes a %s message at priority %i', async (level, expected) => {
        const { requests, ctx } = capture(ok())
        await ntfy.send({ source: 'github', title: 'x', level }, params, ctx)
        expect(((await requests[0]!.json()) as { priority: number }).priority).toBe(expected)
    })

    it('authenticates with an access token', async () => {
        const { requests, ctx } = capture(ok())
        await ntfy.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, TOKEN: 'tk_secret' }, ctx)
        expect(requests[0]!.headers.get('authorization')).toBe('Bearer tk_secret')
    })

    it.each([
        ['https://ntfy.example', 'https://ntfy.example/'],
        ['https://ntfy.example/', 'https://ntfy.example/'],
        ['https://example.com/ntfy', 'https://example.com/ntfy/'],
    ])('publishes to a server of its own at %s', async (server, expected) => {
        const { requests, ctx } = capture(ok())
        await ntfy.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, SERVER: server }, ctx)
        expect(requests[0]!.url).toBe(expected)
    })

    it('reports a refused publish by status', async () => {
        const answer = JSON.stringify({ code: 40301, http: 403, error: 'forbidden' })
        const { ctx } = capture(new Response(answer, { status: 403 }))
        const error = await ntfy.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('HTTP 403')
    })

    it('turns 429 into a rate limit', async () => {
        const { ctx } = capture(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
        const error = await ntfy.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(2000)
    })
})
