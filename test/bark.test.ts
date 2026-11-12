import { describe, expect, it } from 'vitest'
import type { Level } from '../src/core/message'
import { RateLimited } from '../src/core/http'
import { bark } from '../src/outbound/bark'

const params = { KEY: 'device-key-secret' }

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): never => {
        throw new Error('bark does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_000, signal: new AbortController().signal, channel: 'phone' } }
}

const ok = () => new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 })

describe('bark', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(bark.type).toBe('bark')
        expect([...bark.params]).toEqual(['KEY'])
        expect([...(bark.optional ?? [])]).toEqual(['SERVER'])
    })

    it('pushes every field to its slot on the official server', async () => {
        const { requests, ctx } = capture(ok())
        await bark.send(
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
        expect(request.url).toBe('https://api.day.app/push')
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(await request.json()).toEqual({
            device_key: 'device-key-secret',
            title: 'deploy failed',
            body: 'prod is down',
            markdown: '**prod** is down',
            level: 'critical',
            url: 'https://example.com/run',
            group: 'deploys',
            // SHA-256 of the key, base64url: any key fits the 64 bytes APNs allows a collapse ID
            id: 'nx0slVoF-Dv8R-SrmfomsE_VxTxaC9HjeRlmwzdUsks',
        })
    })

    it.each<[Level, string]>([
        ['low', 'passive'],
        ['normal', 'active'],
        ['high', 'timeSensitive'],
        ['critical', 'critical'],
    ])('notifies a %s message as %s', async (level, expected) => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'x', level }, params, ctx)
        expect(((await requests[0]!.json()) as { level: string }).level).toBe(expected)
    })

    it('leaves out the fields a message does not have', async () => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'only a title', level: 'normal' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ device_key: 'device-key-secret', title: 'only a title', level: 'active' })
    })

    it('replaces by the same id for the same key', async () => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'x', level: 'normal', key: 'k1' }, params, ctx)
        expect(((await requests[0]!.json()) as { id: string }).id).toBe('arnx6499M4j0-dWG9m6Z_VQIDfLERvDlhmiwnAihbdA')
    })

    it.each([
        ['https://bark.example', 'https://bark.example/push'],
        ['https://bark.example/', 'https://bark.example/push'],
        ['https://example.com/bark', 'https://example.com/bark/push'],
    ])('pushes to a server of its own at %s', async (server, expected) => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, SERVER: server }, ctx)
        expect(requests[0]!.url).toBe(expected)
    })

    it('reports a refused push by status, without the server text, which names the key', async () => {
        const answer = JSON.stringify({ code: 400, message: 'failed to get device token: device-key-secret not found' })
        const { ctx } = capture(new Response(answer, { status: 400 }))
        const error = await bark.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('HTTP 400')
    })

    it('turns 429 into a rate limit', async () => {
        const { ctx } = capture(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
        const error = await bark.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(1000)
    })
})
