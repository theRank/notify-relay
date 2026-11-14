import { describe, expect, it } from 'vitest'
import { RateLimited } from '../src/core/http'
import type { Message } from '../src/core/message'
import { gmail } from '../src/outbound/gmail'
import { decode, parseMail, utf8 } from './mail'

const params = { CLIENT_ID: 'client.apps.example', CLIENT_SECRET: 'csecret', REFRESH_TOKEN: 'rtoken', TO: 'you@example.com' }
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

function fake(token: Response, sent: Response = Response.json({ id: 'm1' })) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push(request)
        return request.url === TOKEN_URL ? token.clone() : sent.clone()
    }
    const connect = (): never => {
        throw new Error('gmail does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 0, signal: new AbortController().signal, channel: 'gmail' } }
}

const granted = () => Response.json({ access_token: 'ya29.access', expires_in: 3599, token_type: 'Bearer' })

async function sentMail(request: Request) {
    const { raw } = (await request.json()) as { raw: string }
    return { raw, ...parseMail(utf8(raw)) }
}

const message: Message = {
    source: 'ci',
    title: '部署失败 deploy failed',
    text: 'functions-deploy failed on main\nsee the run',
    url: 'https://github.com/example/run',
    key: 'k1',
    group: 'ci',
    level: 'high',
}

describe('gmail', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(gmail.type).toBe('gmail')
        expect([...gmail.params]).toEqual(['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'TO'])
        expect([...(gmail.optional ?? [])]).toEqual(['FROM', 'ALLOW_TO'])
    })

    it('mints an access token from the refresh token, then sends as the authorized account', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send(message, params, ctx)

        expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TOKEN_URL}`, `POST ${SEND_URL}`])
        expect(Object.fromEntries(await requests[0]!.formData())).toEqual({
            client_id: 'client.apps.example',
            client_secret: 'csecret',
            refresh_token: 'rtoken',
            grant_type: 'refresh_token',
        })
        expect(requests[1]!.headers.get('authorization')).toBe('Bearer ya29.access')
        expect(requests[1]!.headers.get('content-type')).toBe('application/json')
    })

    it('maps title to the subject and text to a plain body, adding nothing', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send(message, params, ctx)
        const { raw, headers, parts } = await sentMail(requests[1]!)

        expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(headers.to).toBe('you@example.com')
        expect(headers.from).toBeUndefined()
        expect(headers.subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
        expect(decode(headers.subject!)).toBe('部署失败 deploy failed')
        expect(parts).toHaveLength(1)
        expect(parts[0]!.headers['content-type']).toBe('text/plain; charset=UTF-8')
        expect(parts[0]!.content).toBe('functions-deploy failed on main\nsee the run')
    })

    it('falls back to the title when a message has no text, so the body is never empty', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send({ source: 's', title: 'only a title', level: 'low' }, params, ctx)
        const { parts } = await sentMail(requests[1]!)
        expect(parts.map((p) => p.content)).toEqual(['only a title'])
    })

    it('sends rich as the HTML alternative, beside the plain text', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send({ ...message, rich: '<p>functions-deploy <b>failed</b></p>' }, params, ctx)
        const { headers, parts } = await sentMail(requests[1]!)

        expect(headers['content-type']).toMatch(/^multipart\/alternative; boundary="[^"]+"$/)
        expect(parts.map((p) => p.headers['content-type'])).toEqual([
            'text/plain; charset=UTF-8',
            'text/html; charset=UTF-8',
        ])
        expect(parts.map((p) => p.content)).toEqual([
            'functions-deploy failed on main\nsee the run',
            '<p>functions-deploy <b>failed</b></p>',
        ])
    })

    it('keeps the title as the plain alternative when only rich is given', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send({ source: 's', title: 'report', rich: '<h1>report</h1>', level: 'low' }, params, ctx)
        const { parts } = await sentMail(requests[1]!)
        expect(parts.map((p) => p.content)).toEqual(['report', '<h1>report</h1>'])
    })

    it('folds a long title into encoded-words, keeping every header line within 76 characters', async () => {
        const title = '部署失败 🚀 deploy failed, '.repeat(30)
        const { requests, ctx } = fake(granted())
        await gmail.send({ ...message, title }, params, ctx)
        const { lines, headers } = await sentMail(requests[1]!)

        expect(headers.subject!.split(' ').length).toBeGreaterThan(1)
        expect(decode(headers.subject!)).toBe(title)
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
    })

    it('sends from FROM, keeping its display name', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send(message, { ...params, FROM: 'Home Relay <relay@example.com>' }, ctx)
        const { headers } = await sentMail(requests[1]!)
        expect(headers.from).toBe('"Home Relay" <relay@example.com>')
    })

    it('writes every address of TO, quoting ASCII names and encoding the others', async () => {
        const TO = 'you@example.com, Ops <ops@example.com>, "Doe, Jane" <jane@example.com>, "say \\"hi\\"" <hi@example.com>, 运维值班 <oncall@example.com>, <bare@example.com>'
        const { requests, ctx } = fake(granted())
        await gmail.send(message, { ...params, TO }, ctx)
        const { lines, headers } = await sentMail(requests[1]!)

        expect(headers.to).toMatch(/, =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <oncall@example\.com>, /)
        expect(decode(headers.to!)).toBe(
            'you@example.com, "Ops" <ops@example.com>, "Doe, Jane" <jane@example.com>, "say \\"hi\\"" <hi@example.com>, 运维值班 <oncall@example.com>, bare@example.com',
        )
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
    })

    it.each([
        ['spaces', 'Ops    <ops@example.com>', '"Ops" <ops@example.com>'],
        ['a folded line', 'Ops\r\n <ops@example.com>', '"Ops" <ops@example.com>'],
        ['an angle bracket in the name', 'a<b <ops@example.com>', '"a<b" <ops@example.com>'],
    ])('takes %s between a name and its address', async (_, TO, expected) => {
        const { requests, ctx } = fake(granted())
        await gmail.send(message, { ...params, TO }, ctx)
        expect((await sentMail(requests[1]!)).headers.to).toBe(expected)
    })

    it('splits a long encoded name across lines', async () => {
        const name = '家庭实验室的通知机器人'.repeat(4)
        const { requests, ctx } = fake(granted())
        await gmail.send(message, { ...params, FROM: `${name} <relay@example.com>` }, ctx)
        const { lines, headers } = await sentMail(requests[1]!)

        expect(decode(headers.from!)).toBe(`${name} <relay@example.com>`)
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
    })

    it.each([
        ['TO', 'not an address'],
        ['TO', 'you@example.com\r\nBcc: spy@example.com'],
        ['TO', 'Doe, Jane <jane@example.com>'],
        ['TO', 'you@example.com,'],
        ['TO', 'Jane "JD" Doe <jane@example.com>'],
        ['FROM', 'Relay\r\nBcc: spy@example.com <relay@example.com>'],
        ['FROM', 'Relay <relay@example.com'],
        ['FROM', 'Relay <relay@example.com>>'],
        ['TO', 'Ops\u2028Bcc <ops@example.com>'],
        ['FROM', 'a@example.com, b@example.com'],
        ['TO', 'you@typo@example.com'],
        ['TO', 'Ops <ops@typo@example.com>'],
        ['TO', 'ops@例え.jp'],
        ['FROM', 'Relay <中继@example.com>'],
    ])('rejects a malformed %s before minting a token, without echoing it', async (param, value) => {
        const { requests, ctx } = fake(granted())
        const error = await gmail.send(message, { ...params, [param]: value }, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe(`invalid ${param}`)
        expect(requests).toHaveLength(0)
    })

    it('addresses the message\'s own recipients when ALLOW_TO allows them', async () => {
        const { requests, ctx } = fake(granted())
        await gmail.send({ ...message, to: { gmail: 'team@example.org' } }, { ...params, ALLOW_TO: '*@example.org' }, ctx)
        const { headers } = await sentMail(requests[1]!)
        expect(headers.to).toBe('team@example.org')
    })

    it('refuses the message\'s own recipients on a channel without ALLOW_TO, before minting a token', async () => {
        const { requests, ctx } = fake(granted())
        const error = await gmail.send({ ...message, to: { gmail: 'team@example.org' } }, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe('custom recipients not enabled')
        expect(requests).toHaveLength(0)
    })

    it('reports a revoked or expired refresh token clearly and sends nothing', async () => {
        const { requests, ctx } = fake(Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe('refresh token revoked or expired (invalid_grant)')
        expect(requests).toHaveLength(1)
    })

    it('reports other token failures by status, without secrets', async () => {
        const { ctx } = fake(new Response('boom', { status: 500 }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe('HTTP 500')
    })

    it('turns a 429 from Gmail into a rate limit', async () => {
        const { ctx } = fake(granted(), new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(1000)
    })

    it('reports a rejected send by status', async () => {
        const { ctx } = fake(granted(), new Response('forbidden', { status: 403 }))
        const error = await gmail.send(message, params, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe('HTTP 403')
    })
})
