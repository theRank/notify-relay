import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'
import type { Level } from '../core/message'
import { keyId } from './key'

const LEVELS: Record<Level, string> = { low: 'passive', normal: 'active', high: 'timeSensitive', critical: 'critical' }

export const bark: Outbound = {
    type: 'bark',
    params: ['KEY'],
    optional: ['SERVER'],
    async send(message, params, { fetch, signal }) {
        const server = (params.SERVER ?? 'https://api.day.app').replace(/\/+$/, '')
        const { title, text, rich, level, url, group, key } = message
        const response = await fetch(`${server}/push`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                device_key: param(params, 'KEY'),
                title,
                ...(text && { body: text }),
                ...(rich && { markdown: rich }),
                level: LEVELS[level],
                ...(url && { url }),
                ...(group && { group }),
                ...(key && { id: await keyId(key) }),
            }),
            signal,
        })
        await expectOk(response)
    },
}
