import { describe, expect, it } from 'vitest'
import { resolveChannels } from '../src/core/channels'
import type { Outbound } from '../src/core/deliver'
import { adapters as registered } from '../src/outbound'

describe('registered channel types', () => {
    it('never use TYPE as a parameter, since CHANNEL_<NAME>_TYPE declares the channel', () => {
        for (const adapter of Object.values(registered)) {
            expect(adapter.params).not.toContain('TYPE')
            expect(adapter.optional ?? []).not.toContain('TYPE')
        }
    })
})

const fake = (type: string, params: string[], optional: string[] = []): Outbound => ({ type, params, optional, send: async () => {} })
const adapters = {
    loki: fake('loki', ['URL', 'USER', 'TOKEN']),
    discord: fake('discord', ['WEBHOOK']),
    mail: fake('mail', ['TO'], ['FROM']),
}

describe('resolveChannels', () => {
    it('finds each CHANNEL_<NAME>_TYPE and reads its parameters', () => {
        const channels = resolveChannels(
            {
                CHANNEL_LOKI_TYPE: 'loki',
                CHANNEL_LOKI_URL: 'https://logs.example/push',
                CHANNEL_LOKI_USER: '123456',
                CHANNEL_LOKI_TOKEN: 'secret',
                TOKEN_GITHUB: 'nr_x',
            },
            adapters,
        )
        expect([...channels.keys()]).toEqual(['loki'])
        const loki = channels.get('loki')!
        expect(loki.adapter).toBe(adapters.loki)
        expect(loki.params).toEqual({ URL: 'https://logs.example/push', USER: '123456', TOKEN: 'secret' })
        expect(loki.missing).toEqual([])
    })

    it('allows several channels of the same type', () => {
        const channels = resolveChannels(
            {
                CHANNEL_OPS_TYPE: 'discord',
                CHANNEL_OPS_WEBHOOK: 'https://discord.example/ops',
                CHANNEL_FAMILY_TYPE: 'discord',
                CHANNEL_FAMILY_WEBHOOK: 'https://discord.example/family',
            },
            adapters,
        )
        expect([...channels.keys()].sort()).toEqual(['family', 'ops'])
        expect(channels.get('ops')!.params).toEqual({ WEBHOOK: 'https://discord.example/ops' })
        expect(channels.get('family')!.params).toEqual({ WEBHOOK: 'https://discord.example/family' })
    })

    it('names a channel after the whole middle part, lowercase with dashes', () => {
        const channels = resolveChannels(
            { CHANNEL_HOME_LAB_TYPE: 'discord', CHANNEL_HOME_LAB_WEBHOOK: 'https://discord.example/x' },
            adapters,
        )
        expect([...channels.keys()]).toEqual(['home-lab'])
        expect(channels.get('home-lab')!.missing).toEqual([])
    })

    it('lists the parameters a channel is missing', () => {
        const channels = resolveChannels(
            { CHANNEL_LOKI_TYPE: 'loki', CHANNEL_LOKI_URL: 'https://logs.example/push', CHANNEL_LOKI_USER: '' },
            adapters,
        )
        expect(channels.get('loki')!.missing).toEqual(['USER', 'TOKEN'])
    })

    it('reads an optional parameter when it is set and never lists it as missing', () => {
        const channels = resolveChannels(
            {
                CHANNEL_HOME_TYPE: 'mail',
                CHANNEL_HOME_TO: 'you@example.com',
                CHANNEL_HOME_FROM: 'Relay <relay@example.com>',
                CHANNEL_WORK_TYPE: 'mail',
                CHANNEL_WORK_TO: 'boss@example.com',
                CHANNEL_WORK_FROM: '',
            },
            adapters,
        )
        expect(channels.get('home')!.params).toEqual({ TO: 'you@example.com', FROM: 'Relay <relay@example.com>' })
        expect(channels.get('home')!.missing).toEqual([])
        expect(channels.get('work')!.params).toEqual({ TO: 'boss@example.com' })
        expect(channels.get('work')!.missing).toEqual([])
    })

    it('keeps a channel of an unknown type, without an adapter', () => {
        const channels = resolveChannels({ CHANNEL_PAGER_TYPE: 'pagerduty' }, adapters)
        expect(channels.get('pager')).toEqual({ name: 'pager', type: 'pagerduty', params: {}, missing: [] })
    })

    it.each(['toString', 'constructor', '__proto__'])('takes %s, which every object has, for an unknown type as well', (type) => {
        const channels = resolveChannels({ CHANNEL_PAGER_TYPE: type }, adapters)
        expect(channels.get('pager')).toEqual({ name: 'pager', type, params: {}, missing: [] })
    })

    it('ignores everything that does not declare a channel', () => {
        const channels = resolveChannels(
            { TOKEN_GITHUB: 'nr_x', CHANNEL_LOKI_URL: 'https://logs.example/push', CHANNEL_TYPE: 'loki', OTHER: 1 },
            adapters,
        )
        expect(channels.size).toBe(0)
    })
})
