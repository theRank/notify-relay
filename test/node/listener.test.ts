import { Agent, createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppDeps } from '../../src/app'
import { listener } from '../../src/platforms/node/listener'

const env = {
    CHANNEL_LOKI_TYPE: 'loki',
    CHANNEL_LOKI_URL: 'https://logs.example/loki/api/v1/push',
    CHANNEL_LOKI_USER: '123456',
    CHANNEL_LOKI_TOKEN: 'glc_secret',
    TOKEN_GITHUB: 'nr_github',
}

const servers: Server[] = []

afterEach(() => {
    vi.restoreAllMocks()
    for (const server of servers.splice(0)) server.close()
})

async function serve(config: object = env) {
    const pushed: Request[] = []
    const deps: AppDeps = {
        fetch: async (input, init) => {
            pushed.push(new Request(input, init))
            return new Response(null, { status: 204 })
        },
        connect: () => {
            throw new Error('loki does not connect')
        },
        now: () => 1_760_000_000_000,
        sleep: async () => {},
    }
    const server = createServer(listener(config, deps))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    return { origin, pushed }
}

describe('node listener', () => {
    it('hands the method, path, query, headers and body to the relay', async () => {
        const { origin, pushed } = await serve()
        const response = await fetch(`${origin}/webhook?channels=loki`, {
            method: 'POST',
            headers: { authorization: 'Bearer nr_github', 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'deploy done', text: 'über' }),
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json')
        expect(await response.json()).toEqual({ messages: [{ delivered: ['loki'], failed: [] }] })
        const { streams } = (await pushed[0]!.json()) as { streams: { values: [string, string][] }[] }
        const [[, line]] = streams[0]!.values as [[string, string]]
        expect(JSON.parse(line)).toEqual({ title: 'deploy done', text: 'über' })
    })

    it('passes the status and headers of a bodiless answer back', async () => {
        const { origin } = await serve()
        const response = await fetch(`${origin}/webhook?channels=loki`, { method: 'POST', body: '{"title":"x"}' })

        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
        expect(await response.text()).toBe('')
    })

    it('serves /healthz', async () => {
        const { origin } = await serve()
        const response = await fetch(`${origin}/healthz`)

        expect(response.status).toBe(200)
        expect(await response.text()).toBe('ok')
    })

    it('answers an oversized body with 413, draining the rest', async () => {
        const { origin, pushed } = await serve()
        const status = await new Promise<number>((resolve, reject) => {
            const req = httpRequest(`${origin}/webhook?channels=loki`, {
                method: 'POST',
                headers: { authorization: 'Bearer nr_github', 'transfer-encoding': 'chunked' },
            })
            req.on('response', (res) => {
                res.resume()
                resolve(res.statusCode!)
            })
            req.on('error', reject)
            req.end('x'.repeat(64 * 1024 + 1))
        })

        expect(status).toBe(413)
        expect(pushed).toHaveLength(0)
    })

    it('drains a body the relay never read, so the connection carries the next request', async () => {
        const { origin } = await serve()
        const agent = new Agent({ keepAlive: true, maxSockets: 1 })
        const ask = (path: string, body?: string) =>
            new Promise<number>((resolve, reject) => {
                const req = httpRequest(`${origin}${path}`, { agent, method: body === undefined ? 'GET' : 'POST' })
                req.on('response', (res) => {
                    res.resume()
                    res.on('end', () => resolve(res.statusCode!))
                })
                req.on('error', reject)
                req.end(body)
            })

        expect(await ask('/webhook?channels=loki', 'x'.repeat(1024 * 1024))).toBe(401)
        expect(await ask('/healthz')).toBe(200)
        agent.destroy()
    }, 2000)

    it('answers 500 when the relay throws, and keeps serving', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const broken = new Proxy(env, {
            ownKeys() {
                throw new Error('boom')
            },
        })
        const { origin } = await serve(broken)

        const response = await fetch(`${origin}/webhook?channels=loki`, {
            method: 'POST',
            headers: { authorization: 'Bearer nr_github' },
            body: '{"title":"x"}',
        })
        expect(response.status).toBe(500)
        expect(await response.text()).toBe('')
        expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
        expect((await fetch(`${origin}/nope`)).status).toBe(404)
    })

    it('answers 501 to TRACE, which a Request cannot carry, without logging an error', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { origin } = await serve()
        const status = await new Promise<number>((resolve, reject) => {
            const req = httpRequest(`${origin}/webhook?channels=loki`, { method: 'TRACE' })
            req.on('response', (res) => {
                res.resume()
                resolve(res.statusCode!)
            })
            req.on('error', reject)
            req.end()
        })

        expect(status).toBe(501)
        expect(logged).not.toHaveBeenCalled()
    })

    it('ignores the Host header, which the client controls', async () => {
        const { origin } = await serve()
        const status = await new Promise<number>((resolve, reject) => {
            const req = httpRequest(`${origin}/healthz`, { headers: { host: 'a b' } })
            req.on('response', (res) => {
                res.resume()
                resolve(res.statusCode!)
            })
            req.on('error', reject)
            req.end()
        })

        expect(status).toBe(200)
    })
})
