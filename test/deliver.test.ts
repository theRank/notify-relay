import { describe, expect, it } from 'vitest'
import type { Channel } from '../src/core/channels'
import { deliver, type Outbound } from '../src/core/deliver'
import { RateLimited } from '../src/core/http'
import type { Message } from '../src/core/message'
import { webhook } from '../src/outbound/webhook'

const message: Message = { source: 'test', title: 'hello', level: 'normal' }

type Behaviour = 'ok' | 'fail' | 'hang' | number

// Each call consumes the next behaviour; a number means 429 asking to wait that many milliseconds
function channel(name: string, behaviours: Behaviour[], calls: string[]): Channel {
    const adapter: Outbound = {
        type: 'fake',
        params: [],
        async send(_msg, _params, ctx) {
            calls.push(name)
            const next = behaviours.shift() ?? 'ok'
            if (next === 'fail') throw new Error('HTTP 500')
            if (typeof next === 'number') throw new RateLimited(next)
            if (next === 'hang') {
                await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
            }
        },
    }
    return { name, type: 'fake', adapter, params: {}, missing: [] }
}

function setup(spec: Record<string, Behaviour[]>, extra: Channel[] = []) {
    const calls: string[] = []
    const sleeps: number[] = []
    const channels = new Map<string, Channel>(
        [...Object.entries(spec).map(([name, b]) => channel(name, b, calls)), ...extra].map((c) => [c.name, c]),
    )
    const deps = {
        channels,
        fetch: async () => new Response(null),
        connect: (): never => {
            throw new Error('fake channels do not connect')
        },
        now: () => 0,
        sleep: async (ms: number) => void sleeps.push(ms),
        timeoutMs: 20,
    }
    return { calls, sleeps, deps }
}

describe('deliver', () => {
    it('tells each adapter which channel it is sending for', async () => {
        const seen: string[] = []
        const adapter: Outbound = { type: 'fake', params: [], send: async (_msg, _params, ctx) => void seen.push(ctx.channel) }
        const channels = new Map<string, Channel>(
            ['ops', 'family'].map((name) => [name, { name, type: 'fake', adapter, params: {}, missing: [] }]),
        )
        const connect = (): never => {
            throw new Error('fake channels do not connect')
        }
        await deliver(message, ['ops', 'family'], [], { channels, fetch: async () => new Response(null), connect, now: () => 0, sleep: async () => {} })
        expect(seen.sort()).toEqual(['family', 'ops'])
    })

    it('sends to the whole primary group', async () => {
        const { calls, deps } = setup({ a: ['ok'], b: ['ok'] })
        const outcome = await deliver(message, ['a', 'b'], ['c'], deps)
        expect(outcome).toEqual({ ok: true, delivered: ['a', 'b'], failed: [] })
        expect(calls.sort()).toEqual(['a', 'b'])
    })

    it('needs only one primary success and then skips the fallback', async () => {
        const { calls, deps } = setup({ a: ['fail'], b: ['ok'], c: ['ok'] })
        const outcome = await deliver(message, ['a', 'b'], ['c'], deps)
        expect(outcome).toEqual({ ok: true, delivered: ['b'], failed: [{ channel: 'a', error: 'HTTP 500' }] })
        expect(calls).not.toContain('c')
    })

    it('walks the fallback in order and stops at the first success', async () => {
        const { calls, deps } = setup({ a: ['fail'], c: ['fail'], d: ['ok'], e: ['ok'] })
        const outcome = await deliver(message, ['a'], ['c', 'd', 'e'], deps)
        expect(outcome.ok).toBe(true)
        expect(outcome.delivered).toEqual(['d'])
        expect(calls).toEqual(['a', 'c', 'd'])
    })

    it('fails when every channel fails', async () => {
        const { deps } = setup({ a: ['fail'], c: ['fail'] })
        const outcome = await deliver(message, ['a'], ['c'], deps)
        expect(outcome).toEqual({
            ok: false,
            delivered: [],
            failed: [
                { channel: 'a', error: 'HTTP 500' },
                { channel: 'c', error: 'HTTP 500' },
            ],
        })
    })

    it('gives up on a channel that does not answer in time', async () => {
        const { deps } = setup({ a: ['hang'] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'a', error: 'timeout' }])
    })

    it('retries a short rate limit once', async () => {
        const { calls, sleeps, deps } = setup({ a: [1500, 'ok'] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.delivered).toEqual(['a'])
        expect(sleeps).toEqual([1500])
        expect(calls).toEqual(['a', 'a'])
    })

    it('does not wait out a long rate limit', async () => {
        const { calls, sleeps, deps } = setup({ a: [2500] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'a', error: 'rate limited' }])
        expect(sleeps).toEqual([])
        expect(calls).toEqual(['a'])
    })

    it('retries at most once', async () => {
        const { calls, deps } = setup({ a: [100, 100, 'ok'] })
        const outcome = await deliver(message, ['a'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'a', error: 'rate limited' }])
        expect(calls).toEqual(['a', 'a'])
    })

    it('fails a channel that is missing parameters without calling it', async () => {
        const broken: Channel = { ...channel('logs', ['ok'], []), missing: ['USER', 'TOKEN'] }
        const { deps } = setup({}, [broken])
        const outcome = await deliver(message, ['logs'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'logs', error: 'missing USER, TOKEN' }])
    })

    it('fails a channel of an unknown type', async () => {
        const { deps } = setup({}, [{ name: 'pager', type: 'pagerduty', params: {}, missing: [] }])
        const outcome = await deliver(message, ['pager'], [], deps)
        expect(outcome.failed).toEqual([{ channel: 'pager', error: "unknown type 'pagerduty'" }])
    })

    describe('keeps the channel’s settings out of the outcome, which goes to the sender', () => {
        const failing = (params: Record<string, string>, error: string): Channel => ({
            name: 'hook',
            type: 'fake',
            adapter: {
                type: 'fake',
                params: [],
                send: async () => {
                    throw new Error(error)
                },
            },
            params,
            missing: [],
        })
        const failure = async (params: Record<string, string>, error: string) => {
            const { deps } = setup({}, [failing(params, error)])
            return (await deliver(message, ['hook'], [], deps)).failed
        }

        it('in place of a setting an error quotes', async () => {
            const URL = 'https://hooks.example.com/services/T0/B0/s3cr3t'
            const TOKEN = 'tok-0123456789'
            expect(await failure({ URL, TOKEN }, `Failed to parse URL from ${URL}, with ${TOKEN}`)).toEqual([
                { channel: 'hook', error: 'Failed to parse URL from <redacted>, with <redacted>' },
            ])
        })

        it('in place of a setting within another, URL-encoded, or as the URL it normalizes to', async () => {
            const SERVER = 'HTTPS://Proxy.Example.com:443'
            const TOKEN = '123:abc/def+ghi'
            const encoded = new URL(`bot${encodeURIComponent(TOKEN)}/send`, SERVER).href
            expect(encoded).toBe('https://proxy.example.com/bot123%3Aabc%2Fdef%2Bghi/send')
            expect(await failure({ SERVER, TOKEN }, `cannot load ${encoded} or ${SERVER}/bot${TOKEN}/send`)).toEqual([
                { channel: 'hook', error: 'cannot load <redacted>bot<redacted>/send or <redacted>/bot<redacted>/send' },
            ])
        })

        // As in a status, a port or a topic's number
        it('but not a setting under 8 characters, too likely to turn up by chance', async () => {
            expect(await failure({ THREAD: '1', PORT: '587', USER: 'ops' }, 'HTTP 401 on port 587 for ops')).toEqual([
                { channel: 'hook', error: 'HTTP 401 on port 587 for ops' },
            ])
        })

        it('in place of a setting the runtime’s fetch quotes, such as a URL it cannot parse', async () => {
            const URL = 'htps//hooks.example.com/hook/s3cr3t-0123456789'
            const { deps } = setup({}, [{ name: 'hook', type: 'webhook', adapter: webhook, params: { URL }, missing: [] }])
            const outcome = await deliver(message, ['hook'], [], { ...deps, fetch })
            expect(outcome.failed).toHaveLength(1)
            expect(outcome.failed[0]!.error).not.toContain('s3cr3t')
        })
    })
})
