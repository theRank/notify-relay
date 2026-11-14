import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Level } from '../src/core/message'
import { discord } from '../src/outbound/discord'

const params = { URL: 'https://discord.com/api/webhooks/123/secret' }

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): never => {
        throw new Error('discord does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_000, signal: new AbortController().signal, channel: 'ops' } }
}

const ok = () => Response.json({ id: '789', channel_id: '123' })

describe('discord', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(discord.type).toBe('discord')
        expect([...discord.params]).toEqual(['URL'])
        expect(discord.optional).toBeUndefined()
    })

    it('posts an embed with the title linked to the url and the text as its description', async () => {
        const { requests, ctx } = capture(ok())
        await discord.send(
            { source: 'github', title: 'deploy done', text: 'all green\nin 3 minutes', level: 'normal', url: 'https://example.com/run' },
            params,
            ctx,
        )

        expect(requests).toHaveLength(1)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        expect(request.url).toBe(`${params.URL}?wait=true`)
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(await request.json()).toEqual({
            embeds: [{ title: 'deploy done', description: 'all green\nin 3 minutes', url: 'https://example.com/run', color: 0x3498db }],
        })
    })

    it.each([
        ['keeps a thread_id in the webhook URL, which picks the thread', '?thread_id=456', '?thread_id=456&wait=true'],
        ['waits for the message to be saved even when the URL says not to', '?wait=false', '?wait=true'],
    ])('%s', async (_, query, expected) => {
        const { requests, ctx } = capture(ok())
        await discord.send({ source: 'github', title: 'x', level: 'normal' }, { URL: `${params.URL}${query}` }, ctx)
        expect(requests[0]!.url).toBe(`${params.URL}${expected}`)
    })

    it('shows rich as Discord Markdown in place of the text, as written', async () => {
        const { requests, ctx } = capture(ok())
        await discord.send(
            { source: 'github', title: 'deploy done', text: 'all green', rich: '**all** green, <@123>', level: 'normal' },
            params,
            ctx,
        )
        const { embeds } = (await requests[0]!.json()) as { embeds: { description: string }[] }
        expect(embeds[0]!.description).toBe('**all** green, <@123>')
    })

    it('posts a lone title as an embed of its own', async () => {
        const { requests, ctx } = capture(ok())
        await discord.send({ source: 'github', title: 'deploy done', level: 'normal' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ embeds: [{ title: 'deploy done', color: 0x3498db }] })
    })

    async function posted(title: string, text: string): Promise<{ title: string; description: string }> {
        const { requests, ctx } = capture(ok())
        await discord.send({ source: 'github', title, text, level: 'normal' }, params, ctx)
        const { embeds } = (await requests[0]!.json()) as { embeds: { title: string; description: string }[] }
        return { title: embeds[0]!.title, description: embeds[0]!.description }
    }

    it('escapes what Discord would render in the title and the text, so it shows as written', async () => {
        const text = [
            '# no heading',
            '## no heading',
            '-# no subtext',
            '- no list',
            '+ no list',
            '  * no list',
            '1. no list',
            '> no quote',
            '>>> no quote',
            '`a` *b* _c_ __init__ 中_文_字 ~~d~~ ||e|| [f](g) \\* \\',
            '<@123> <@&4> <#5> <:ok:6> <a:ok:7> <t:0> </cmd:8> <id:home> <https://example.com>',
        ].join('\n')
        expect(await posted('deploy *prod* failed', text)).toEqual({
            title: 'deploy \\*prod\\* failed',
            description: [
                '\\# no heading',
                '\\## no heading',
                '\\-# no subtext',
                '\\- no list',
                '\\+ no list',
                '  \\* no list',
                '1\\. no list',
                '\\> no quote',
                '\\>>> no quote',
                '\\`a\\` \\*b\\* \\_c\\_ \\_\\_init\\_\\_ 中\\_文\\_字 \\~\\~d\\~\\~ \\|\\|e\\|\\| \\[f](g) \\\\\\* \\',
                '\\<@123> \\<@&4> \\<#5> \\<:ok:6> \\<a:ok:7> \\<t:0> \\</cmd:8> \\<id:home> \\<https://example.com>',
            ].join('\n'),
        })
    })

    it('leaves what Discord would not render, so a push shows it as written too', async () => {
        const title = '[prod] build_and_test failed: p99 < 200ms, ~5 | 6'
        const text = ['-5 degrees', '#123 failed', '>200 ms', '2.5 seconds', 'C:\\path\\to', '[a] [b]', 'a<b'].join('\n')
        expect(await posted(title, text)).toEqual({ title, description: text })
    })

    it('leaves links in the text whole, so they stay links', async () => {
        const text = 'logs at https://example.com/run_1/*_x?a=b~~c for *run_1*'
        expect((await posted('x', text)).description).toBe('logs at https://example.com/run_1/*_x?a=b~~c for \\*run_1\\*')
    })

    it('escapes a bracket only when the next ] on its line opens a link', async () => {
        const text = ['[a [b](c)', '[a] [b](c)', '[a](b) [c]', '[a', '](b)', '[a]'].join('\n')
        expect((await posted('x', text)).description).toBe(['\\[a \\[b](c)', '[a] \\[b](c)', '\\[a](b) [c]', '[a', '](b)', '[a]'].join('\n'))
    })

    // The escape runs without a pause, where the relay's timeout cannot interrupt it
    it.each([
        ['brackets', '['.repeat(60_000)],
        ['spaces', ' '.repeat(60_000)],
        ['digits', '1'.repeat(60_000)],
        ['quotes', '> '.repeat(30_000)],
    ])('escapes a long text of nothing but %s in time that grows with its length', async (_, text) => {
        const started = performance.now()
        await posted('x', text)
        expect(performance.now() - started).toBeLessThan(1000)
    })

    it.each<[Level, number]>([
        ['low', 0x95a5a6],
        ['normal', 0x3498db],
        ['high', 0xe67e22],
        ['critical', 0xe74c3c],
    ])('colours a %s message %i', async (level, color) => {
        const { requests, ctx } = capture(ok())
        await discord.send({ source: 'github', title: 'x', level }, params, ctx)
        const { embeds } = (await requests[0]!.json()) as { embeds: { color: number }[] }
        expect(embeds[0]!.color).toBe(color)
    })

    it('posts a low message silently, with no push or desktop notification', async () => {
        const { requests, ctx } = capture(ok())
        await discord.send({ source: 'github', title: 'x', level: 'low' }, params, ctx)
        expect(((await requests[0]!.json()) as { flags?: number }).flags).toBe(1 << 12)
    })

    it.each<Level>(['normal', 'high', 'critical'])('notifies of a %s message as usual', async (level) => {
        const { requests, ctx } = capture(ok())
        await discord.send({ source: 'github', title: 'x', level }, params, ctx)
        expect((await requests[0]!.json()) as object).not.toHaveProperty('flags')
    })

    it('has no use for key and group', async () => {
        const { requests, ctx } = capture(ok())
        await discord.send({ source: 'github', title: 'x', level: 'normal', key: 'k', group: 'g' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ embeds: [{ title: 'x', color: 0x3498db }] })
    })

    it.each([400, 404])('reports a refused post by status, without the server text', async (status) => {
        const { ctx } = capture(Response.json({ code: 50035, message: 'Invalid Form Body' }, { status }))
        const error = await discord.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(`HTTP ${status}`)
    })

    it('turns 429 into a rate limit with the delay Discord asks for', async () => {
        const { ctx } = capture(Response.json({ retry_after: 1.5, global: false }, { status: 429, headers: { 'retry-after': '2' } }))
        const error = await discord.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(2000)
    })
})
