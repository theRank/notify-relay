import { describe, expect, it } from 'vitest'
import { allowedChannels, allowlists, authenticate, constantTimeEqual, sources } from '../src/core/auth'

const env = {
    TOKEN_GITHUB: 'nr_github',
    TOKEN_LAPTOP_MAC: 'nr_old nr_new',
    LOKI_TOKEN: 'nr_not_a_source',
    LOKI_USER: '123456',
}

describe('authenticate', () => {
    it('names the source after the secret that holds the token', () => {
        expect(authenticate('Bearer nr_github', env)).toBe('github')
        expect(authenticate('Bearer nr_new', env)).toBe('laptop-mac')
    })

    it('accepts every token in a space-separated secret, so rotation can overlap', () => {
        expect(authenticate('Bearer nr_old', env)).toBe('laptop-mac')
    })

    it('rejects anything else', () => {
        expect(authenticate(null, env)).toBeUndefined()
        expect(authenticate('', env)).toBeUndefined()
        expect(authenticate('Bearer ', env)).toBeUndefined()
        expect(authenticate('Bearer nr_wrong', env)).toBeUndefined()
        expect(authenticate('Basic nr_github', env)).toBeUndefined()
        expect(authenticate('nr_github', env)).toBeUndefined()
    })

    it('only trusts TOKEN_ secrets', () => {
        expect(authenticate('Bearer nr_not_a_source', env)).toBeUndefined()
        expect(authenticate('Bearer 123456', env)).toBeUndefined()
    })
})

describe('sources', () => {
    it('lists the sources that have a token', () => {
        expect(sources({ ...env, TOKEN_EMPTY: ' ', TOKEN_BOUND: {} })).toEqual(['github', 'laptop-mac'])
    })
})

describe('allowedChannels', () => {
    it('is undefined for a source held to no list, which may name any channel', () => {
        expect(allowedChannels('github', env)).toBeUndefined()
        expect(allowedChannels('github', { ...env, ALLOW_LAPTOP_MAC_CHANNELS: 'loki' })).toBeUndefined()
    })

    it('reads the list of the source, named as its token is', () => {
        const held = { ...env, ALLOW_GITHUB_CHANNELS: 'discord, loki,,loki', ALLOW_LAPTOP_MAC_CHANNELS: 'bark' }
        expect(allowedChannels('github', held)).toEqual(['discord', 'loki'])
        expect(allowedChannels('laptop-mac', held)).toEqual(['bark'])
    })

    it('admits nothing for a list that is empty or is no text, rather than everything', () => {
        expect(allowedChannels('github', { ...env, ALLOW_GITHUB_CHANNELS: '' })).toEqual([])
        expect(allowedChannels('github', { ...env, ALLOW_GITHUB_CHANNELS: ' , ' })).toEqual([])
        expect(allowedChannels('github', { ...env, ALLOW_GITHUB_CHANNELS: { bound: true } })).toEqual([])
    })

    it('admits what every list admits when settings differ only in case, as they name one source', () => {
        expect(allowedChannels('github', { ...env, ALLOW_GITHUB_CHANNELS: 'discord,loki', ALLOW_Github_CHANNELS: 'loki,bark' })).toEqual(['loki'])
    })

    it('does not take a list for a token', () => {
        expect(authenticate('Bearer discord,loki', { ...env, ALLOW_GITHUB_CHANNELS: 'discord,loki' })).toBeUndefined()
    })
})

describe('allowlists', () => {
    it('lists every setting with the source it names', () => {
        expect(allowlists({ ...env, ALLOW_GITHUB_CHANNELS: 'loki', ALLOW_NOBODY_CHANNELS: 'discord,bark', CHANNEL_MAIL_ALLOW_TO: '*' })).toEqual([
            { source: 'github', channels: ['loki'] },
            { source: 'nobody', channels: ['discord', 'bark'] },
        ])
    })
})

describe('constantTimeEqual', () => {
    it('compares whole strings', () => {
        expect(constantTimeEqual('nr_abc', 'nr_abc')).toBe(true)
        expect(constantTimeEqual('nr_abc', 'nr_abd')).toBe(false)
        expect(constantTimeEqual('nr_abc', 'nr_ab')).toBe(false)
        expect(constantTimeEqual('', 'nr_abc')).toBe(false)
    })
})
