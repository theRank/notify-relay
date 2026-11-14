import { HttpRequest } from '@azure/functions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppDeps } from '../../src/app'
import { azure } from '../../src/platforms/azure/handler'

const env = {
    CHANNEL_LOKI_TYPE: 'loki',
    CHANNEL_LOKI_URL: 'https://logs.example/loki/api/v1/push',
    CHANNEL_LOKI_USER: '123456',
    CHANNEL_LOKI_TOKEN: 'glc_secret',
    TOKEN_GITHUB: 'nr_github',
}

afterEach(() => {
    vi.restoreAllMocks()
})

function setup(config: object = env) {
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
        log: () => {},
    }
    return { pushed, invoke: azure(config, deps) }
}

// The programming model's own request, which the host builds with the app's host name in the URL
function request(method: string, path: string, headers: Record<string, string> = {}, body?: string): HttpRequest {
    return new HttpRequest({ method, url: `https://notify-relay.azurewebsites.net${path}`, headers, ...(body !== undefined && { body: { string: body } }) })
}

async function pushedLine(request: Request): Promise<unknown> {
    const { streams } = (await request.json()) as { streams: { values: [string, string][] }[] }
    return JSON.parse(streams[0]!.values[0]![1])
}

describe('azure', () => {
    it('hands the method, path, query, headers and body to the relay, and answers with its status, headers and body', async () => {
        const { pushed, invoke } = setup()
        const result = await invoke(
            request(
                'POST',
                '/webhook?channels=loki',
                { authorization: 'Bearer nr_github', 'content-type': 'application/json' },
                JSON.stringify({ title: 'deploy done', text: 'über' }),
            ),
        )

        expect(result).toEqual({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ messages: [{ delivered: ['loki'], failed: [] }] })),
        })
        expect(await pushedLine(pushed[0]!)).toEqual({ title: 'deploy done', text: 'über' })
    })

    it('serves /healthz', async () => {
        const { invoke } = setup()
        const result = await invoke(request('GET', '/healthz'))

        expect(result.status).toBe(200)
        expect(new TextDecoder().decode(result.body as Uint8Array)).toBe('ok')
    })

    it('passes the headers of a bodiless answer back, without a body', async () => {
        const { invoke } = setup()
        const result = await invoke(request('POST', '/webhook?channels=loki', {}, '{"title":"x"}'))

        expect(result).toEqual({ status: 401, headers: { 'www-authenticate': 'Bearer' }, body: null })
    })

    it('refuses a body over 64 KB', async () => {
        const { pushed, invoke } = setup()
        const result = await invoke(request('POST', '/webhook?channels=loki', { authorization: 'Bearer nr_github' }, 'x'.repeat(64 * 1024 + 1)))

        expect(result.status).toBe(413)
        expect(pushed).toHaveLength(0)
    })

    it('answers 500 when the relay throws', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const broken = new Proxy(env, {
            ownKeys() {
                throw new Error('boom')
            },
        })
        const { invoke } = setup(broken)
        const result = await invoke(request('POST', '/webhook?channels=loki', { authorization: 'Bearer nr_github' }, '{"title":"x"}'))

        expect(result).toEqual({ status: 500, headers: {}, body: null })
        expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
    })
})
