import { describe, expect, it } from 'vitest'
import { webhook } from '../src/inbound/webhook'

describe('webhook', () => {
    it('defaults the level to normal', () => {
        expect(webhook.parse({ title: 'deploy done' })).toEqual([{ title: 'deploy done', level: 'normal' }])
    })

    it('keeps every field of the contract', () => {
        const draft = {
            title: 'HostDown oicna',
            text: 'no samples for 15m',
            rich: '<p>no samples for <b>15m</b></p>',
            level: 'high',
            url: 'https://grafana.example/alerting',
            key: 'group-1',
            group: 'alerts',
            to: { mail: 'ops@example.com, "Doe, Jane" <jane@example.com>' },
        }
        expect(webhook.parse(draft)).toEqual([draft])
    })

    it('rejects a body that is not an object', () => {
        for (const body of [null, 'title', 42, ['title']]) {
            expect(() => webhook.parse(body)).toThrow('body must be a JSON object')
        }
    })

    it('rejects unknown fields, so a misspelling surfaces at the sender', () => {
        expect(() => webhook.parse({ titel: 'x' })).toThrow("unknown field 'titel'")
        expect(() => webhook.parse({ title: 'x', source: 'grafana' })).toThrow("unknown field 'source'")
        expect(() => webhook.parse({ title: 'x', body: 'old' })).toThrow("unknown field 'body'")
    })

    it('requires a one-line title', () => {
        expect(() => webhook.parse({})).toThrow('title is required')
        expect(() => webhook.parse({ title: '  ' })).toThrow('title is required')
        expect(() => webhook.parse({ title: 7 })).toThrow('title must be a string')
        expect(() => webhook.parse({ title: 'a\nb' })).toThrow('title must be one line')
    })

    it('checks the level', () => {
        expect(() => webhook.parse({ title: 'x', level: 'urgent' })).toThrow(
            'level must be one of low, normal, high, critical',
        )
    })

    it('only accepts https links', () => {
        expect(() => webhook.parse({ title: 'x', url: 'http://example.com' })).toThrow('url must be https')
        expect(() => webhook.parse({ title: 'x', url: 'javascript:alert(1)' })).toThrow('url must be https')
        expect(() => webhook.parse({ title: 'x', url: 'not a url' })).toThrow('url must be https')
    })

    // A URL parser drops these before it reads the link, but the channels get the link as the sender wrote it
    it.each([' https://example.com', 'https://example.com\n', 'ht\ntps://example.com', 'https://example.com/a b', 'https://example.com/a\tb', '\u0000https://example.com', 'https://example.com/\u007f', 'https://example.com/\u00a0', 'https://example.com/\u2028'])(
        'refuses a link with whitespace or a control character in it: %j',
        (url) => {
            expect(() => webhook.parse({ title: 'x', url })).toThrow('url must not contain whitespace or control characters')
        },
    )

    it('keeps a link as written, non-ASCII and all', () => {
        const url = 'https://example.com/路径?q=é#片段'
        expect(webhook.parse({ title: 'x', url })).toEqual([{ title: 'x', level: 'normal', url }])
    })

    it('checks the optional strings', () => {
        expect(() => webhook.parse({ title: 'x', text: 1 })).toThrow('text must be a string')
        expect(() => webhook.parse({ title: 'x', rich: [] })).toThrow('rich must be a string')
        expect(() => webhook.parse({ title: 'x', key: {} })).toThrow('key must be a string')
        expect(() => webhook.parse({ title: 'x', group: false })).toThrow('group must be a string')
    })

    it('treats an empty optional string as left out, so a mail never gets an empty HTML part', () => {
        expect(webhook.parse({ title: 'x', text: '', rich: '', key: '', group: '' })).toEqual([{ title: 'x', level: 'normal' }])
    })

    it('takes to as channel names mapped to recipients, leaving their syntax to each channel', () => {
        for (const to of ['a@example.com', ['a@example.com'], null, { mail: 1 }, { mail: ['a@example.com'] }]) {
            expect(() => webhook.parse({ title: 'x', to })).toThrow('to must map channel names to recipients')
        }
        expect(webhook.parse({ title: 'x', to: { mail: 'checked by the channel' } })).toEqual([
            { title: 'x', level: 'normal', to: { mail: 'checked by the channel' } },
        ])
    })
})
