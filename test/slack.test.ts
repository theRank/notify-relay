import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Level } from '../src/core/message'
import { slack } from '../src/outbound/slack'

const params = { URL: 'https://hooks.slack.com/services/T000/B000/secret' }

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): never => {
        throw new Error('slack does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_000, signal: new AbortController().signal, channel: 'ops' } }
}

const ok = () => new Response('ok', { status: 200 })

describe('slack', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(slack.type).toBe('slack')
        expect([...slack.params]).toEqual(['URL'])
        expect(slack.optional).toBeUndefined()
    })

    it('posts the title as a header, the text as plain text and the url as a link', async () => {
        const { requests, ctx } = capture(ok())
        await slack.send(
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
            text: 'deploy done',
            blocks: [
                { type: 'header', text: { type: 'plain_text', text: 'deploy done' } },
                { type: 'section', text: { type: 'plain_text', text: 'all green\nin 3 minutes' } },
                { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com/run' }] }] },
            ],
        })
    })

    it('shows rich as Markdown in place of the text', async () => {
        const { requests, ctx } = capture(ok())
        await slack.send({ source: 'github', title: 'deploy done', text: 'all green', rich: '**all** green', level: 'normal' }, params, ctx)
        const { blocks } = (await requests[0]!.json()) as { blocks: unknown[] }
        expect(blocks).toEqual([
            { type: 'header', text: { type: 'plain_text', text: 'deploy done' } },
            { type: 'markdown', text: '**all** green' },
        ])
    })

    it('posts a lone title as a header only', async () => {
        const { requests, ctx } = capture(ok())
        await slack.send({ source: 'github', title: 'deploy done', level: 'normal' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ text: 'deploy done', blocks: [{ type: 'header', text: { type: 'plain_text', text: 'deploy done' } }] })
    })

    // The notification shows the fallback text, which Slack reads as mrkdwn, where &, < and > are markup
    it('escapes the title in the fallback text, so it shows as written', async () => {
        const { requests, ctx } = capture(ok())
        await slack.send({ source: 'github', title: 'a < b & <!channel>', level: 'normal' }, params, ctx)
        const body = (await requests[0]!.json()) as { text: string; blocks: { text: { text: string } }[] }
        expect(body.text).toBe('a &lt; b &amp; &lt;!channel&gt;')
        expect(body.blocks[0]!.text.text).toBe('a < b & <!channel>')
    })

    it.each<Level>(['low', 'normal', 'high', 'critical'])('posts a %s message the same way, having no notion of level', async (level) => {
        const { requests, ctx } = capture(ok())
        await slack.send({ source: 'github', title: 'x', level, key: 'k', group: 'g' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ text: 'x', blocks: [{ type: 'header', text: { type: 'plain_text', text: 'x' } }] })
    })

    it('reports a refused post by status, without the server text', async () => {
        const { ctx } = capture(new Response('invalid_blocks', { status: 400 }))
        const error = await slack.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('HTTP 400')
    })

    it('turns 429 into a rate limit with the delay Slack asks for', async () => {
        const { ctx } = capture(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
        const error = await slack.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(1000)
    })
})
