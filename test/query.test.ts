import { describe, expect, it } from 'vitest'
import { parseChannels } from '../src/core/query'

const known = ['loki', 'discord', 'bark'] as const

function parse(search: string) {
    return parseChannels(new URL(`https://notify.example/webhook${search}`), known)
}

describe('parseChannels', () => {
    it('reads the primary group and the optional fallback', () => {
        expect(parse('?channels=loki')).toEqual({ channels: ['loki'], fallback: [], also: [] })
        expect(parse('?channels=loki,discord&fallback=bark')).toEqual({
            channels: ['loki', 'discord'],
            fallback: ['bark'],
            also: [],
        })
    })

    it('reads the channels that get a copy', () => {
        expect(parse('?channels=discord&fallback=bark&also=loki')).toEqual({
            channels: ['discord'],
            fallback: ['bark'],
            also: ['loki'],
        })
    })

    it('ignores blanks and repeats', () => {
        expect(parse('?channels=%20loki%20,,loki')).toEqual({ channels: ['loki'], fallback: [], also: [] })
    })

    it('requires a primary group', () => {
        expect(parse('')).toEqual({ error: 'channels is required' })
        expect(parse('?channels=')).toEqual({ error: 'channels is required' })
        expect(parse('?fallback=loki')).toEqual({ error: 'channels is required' })
        expect(parse('?also=loki')).toEqual({ error: 'channels is required' })
    })

    it('rejects unknown channels', () => {
        expect(parse('?channels=pager')).toEqual({ error: "unknown channel 'pager'" })
        expect(parse('?channels=loki&fallback=pager')).toEqual({ error: "unknown channel 'pager'" })
        expect(parse('?channels=loki&also=pager')).toEqual({ error: "unknown channel 'pager'" })
    })

    describe('for a source held to a list of channels', () => {
        const held = (search: string) => parseChannels(new URL(`https://notify.example/webhook${search}`), known, ['loki', 'bark'])

        it('reads a route within the list', () => {
            expect(held('?channels=loki&fallback=bark')).toEqual({ channels: ['loki'], fallback: ['bark'], also: [] })
        })

        it.each(['?channels=discord', '?channels=loki&fallback=discord', '?channels=loki&also=discord'])('forbids a channel outside it, as in %s', (search) => {
            expect(held(search)).toEqual({ error: "'discord' is not a channel this token may use", forbidden: true })
        })

        // So that the answer does not tell which other channels the deployment has
        it('forbids a channel outside it that is not configured either, the same way', () => {
            expect(held('?channels=pager')).toEqual({ error: "'pager' is not a channel this token may use", forbidden: true })
        })

        it('still asks for a primary group first', () => {
            expect(held('?fallback=discord')).toEqual({ error: 'channels is required' })
        })
    })

    it('rejects a channel in two groups', () => {
        expect(parse('?channels=loki&fallback=loki')).toEqual({ error: "'loki' is in both channels and fallback" })
        expect(parse('?channels=loki&also=loki')).toEqual({ error: "'loki' is in both channels and also" })
        expect(parse('?channels=discord&fallback=loki&also=loki')).toEqual({ error: "'loki' is in both fallback and also" })
    })
})
