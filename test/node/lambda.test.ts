import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppDeps } from '../../src/app'
import { type LambdaEvent, lambda } from '../../src/platforms/lambda'

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
    return { pushed, invoke: lambda(config, deps) }
}

// As a Function URL sends it, trimmed to what the relay reads and a little more
function event(method: string, path: string, query = '', fields: Partial<LambdaEvent> = {}): LambdaEvent {
    return {
        version: '2.0',
        rawPath: path,
        rawQueryString: query,
        headers: { host: 'abc123.lambda-url.eu-west-1.on.aws', 'x-forwarded-proto': 'https', ...fields.headers },
        requestContext: { http: { method } },
        isBase64Encoded: false,
        ...fields,
    }
}

async function pushedLine(request: Request): Promise<unknown> {
    const { streams } = (await request.json()) as { streams: { values: [string, string][] }[] }
    return JSON.parse(streams[0]!.values[0]![1])
}

describe('lambda', () => {
    it('hands the method, path, query, headers and body to the relay, and answers in payload format 2.0', async () => {
        const { pushed, invoke } = setup()
        const result = await invoke(
            event('POST', '/webhook', 'channels=loki', {
                headers: { authorization: 'Bearer nr_github', 'content-type': 'application/json' },
                body: JSON.stringify({ title: 'deploy done', text: 'über' }),
            }),
        )

        expect(result).toEqual({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ delivered: ['loki'], failed: [] }] }),
            isBase64Encoded: false,
        })
        expect(await pushedLine(pushed[0]!)).toEqual({ title: 'deploy done', text: 'über' })
    })

    it('decodes a body the Function URL sent as base64', async () => {
        const { pushed, invoke } = setup()
        const body = Buffer.from(JSON.stringify({ title: 'über' })).toString('base64')
        const result = await invoke(
            event('POST', '/webhook', 'channels=loki', { headers: { authorization: 'Bearer nr_github' }, body, isBase64Encoded: true }),
        )

        expect(result.statusCode).toBe(200)
        expect(await pushedLine(pushed[0]!)).toEqual({ title: 'über' })
    })

    it('serves /healthz', async () => {
        const { invoke } = setup()
        expect(await invoke(event('GET', '/healthz'))).toMatchObject({ statusCode: 200, body: 'ok' })
    })

    it('passes the headers of a bodiless answer back', async () => {
        const { invoke } = setup()
        const result = await invoke(event('POST', '/webhook', 'channels=loki', { body: '{"title":"x"}' }))

        expect(result).toEqual({ statusCode: 401, headers: { 'www-authenticate': 'Bearer' }, body: '', isBase64Encoded: false })
    })

    it('refuses a body over 64 KB', async () => {
        const { pushed, invoke } = setup()
        const result = await invoke(
            event('POST', '/webhook', 'channels=loki', { headers: { authorization: 'Bearer nr_github' }, body: 'x'.repeat(64 * 1024 + 1) }),
        )

        expect(result.statusCode).toBe(413)
        expect(pushed).toHaveLength(0)
    })

    it.each(['TRACE', 'trace', 'CONNECT', 'TRACK'])('answers 501 to %s, which a Request cannot carry, without logging an error', async (method) => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { invoke } = setup()

        expect(await invoke(event(method, '/webhook', 'channels=loki'))).toEqual({ statusCode: 501, headers: {}, body: '', isBase64Encoded: false })
        expect(logged).not.toHaveBeenCalled()
    })

    it('answers 500 to payload format 1.0, saying which one it needs', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { invoke } = setup()
        const result = await invoke({ ...event('GET', '/healthz'), version: '1.0' })

        expect(result.statusCode).toBe(500)
        expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('payload format 2.0') }))
    })

    it('answers 500 when the relay throws', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const broken = new Proxy(env, {
            ownKeys() {
                throw new Error('boom')
            },
        })
        const { invoke } = setup(broken)
        const result = await invoke(
            event('POST', '/webhook', 'channels=loki', { headers: { authorization: 'Bearer nr_github' }, body: '{"title":"x"}' }),
        )

        expect(result).toEqual({ statusCode: 500, headers: {}, body: '', isBase64Encoded: false })
        expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
    })
})
