import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'
import type { Level } from '../core/message'
import { seal } from './bark-cipher'
import { keyId } from './key'

const LEVELS: Record<Level, string> = { low: 'passive', normal: 'active', high: 'timeSensitive', critical: 'critical' }

export const bark: Outbound = {
    type: 'bark',
    params: ['KEY'],
    optional: ['SERVER', 'ENCRYPTION', 'ENCRYPTION_KEY'],
    async send(message, params, { fetch, signal }) {
        const server = (params.SERVER ?? 'https://api.day.app').replace(/\/+$/, '')
        const { title, text, rich, level, url, group, key } = message
        const id = key && (await keyId(key))
        const fields = {
            title,
            ...(text && { body: text }),
            ...(rich && { markdown: rich }),
            level: LEVELS[level],
            ...(url && { url }),
            ...(group && { group }),
            ...(id && { id }),
        }
        const encrypted = params.ENCRYPTION !== undefined || params.ENCRYPTION_KEY !== undefined
        // The server replaces a notification by its id, so the id stays readable next to the ciphertext
        const payload = encrypted
            ? { ...(id && { id }), ...(await seal(JSON.stringify(fields), param(params, 'ENCRYPTION'), param(params, 'ENCRYPTION_KEY'))) }
            : fields
        const response = await fetch(`${server}/push`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: param(params, 'KEY'), ...payload }),
            signal,
        })
        await expectOk(response)
    },
}
