import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/platforms/cloudflare'

async function call(
    method: string,
    path: string,
    init: RequestInit<IncomingRequestCfProperties> = {},
): Promise<Response> {
    const request = new Request<unknown, IncomingRequestCfProperties>(`https://notify.example${path}`, {
        method,
        ...init,
    })
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)
    return response
}

describe('/healthz', () => {
    it('answers GET without credentials', async () => {
        const response = await call('GET', '/healthz')
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('ok')
    })

    it('rejects other methods', async () => {
        const response = await call('POST', '/healthz')
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET, HEAD')
    })
})

describe('the deployed handler', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('serves /webhook and turns away callers without a token', async () => {
        const response = await call('POST', '/webhook?channels=loki', { body: '{"title":"x"}' })
        expect(response.status).toBe(401)
    })

    // As an object, whose fields Workers Logs can be queried by
    it('logs the request with the runtime console', async () => {
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await call('POST', '/webhook?channels=loki', { body: '{"title":"x"}' })
        expect(warned.mock.calls).toEqual([[{ path: '/webhook', status: 401 }]])
    })

    it('delivers with the runtime fetch, clock and timer', async () => {
        const fetched = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
        const realSetTimeout = globalThis.setTimeout
        const waits: number[] = []
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
            if (ms !== 1000) return realSetTimeout(fn, ms)
            waits.push(ms)
            fn()
            return 0
        }) as unknown as typeof setTimeout)
        const before = Date.now()
        const response = await call('POST', '/webhook?channels=loki', {
            headers: { authorization: 'Bearer nr_test' },
            body: '{"title":"x"}',
        })
        expect(await response.json()).toEqual({ messages: [{ delivered: ['loki'], failed: [] }] })
        expect(waits).toEqual([1000])
        expect(fetched).toHaveBeenCalledTimes(2)
        const [url, init] = fetched.mock.calls[1]!
        expect(url).toBe('https://logs.example/loki/api/v1/push')
        const [[ns]] = JSON.parse(init!.body as string).streams[0].values
        expect(Number(BigInt(ns) / 1_000_000n)).toBeGreaterThanOrEqual(before)
        expect(Number(BigInt(ns) / 1_000_000n)).toBeLessThanOrEqual(Date.now())
    })
})

describe('unknown paths', () => {
    it('are 404', async () => {
        const response = await call('GET', '/nope')
        expect(response.status).toBe(404)
    })
})
