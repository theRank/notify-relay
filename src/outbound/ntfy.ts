import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'
import type { Level } from '../core/message'
import { keyId } from './key'

const PRIORITIES: Record<Level, number> = { low: 2, normal: 3, high: 4, critical: 5 }

export const ntfy: Outbound = {
    type: 'ntfy',
    params: ['TOPIC'],
    optional: ['SERVER', 'TOKEN'],
    async send(message, params, { fetch, signal }) {
        const server = (params.SERVER ?? 'https://ntfy.sh').replace(/\/+$/, '')
        const { title, text, rich, level, url, key } = message
        const body = rich ?? text
        // Publishing JSON to the root keeps a title in any script out of the headers
        const response = await fetch(`${server}/`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(params.TOKEN !== undefined && { authorization: `Bearer ${params.TOKEN}` }),
            },
            body: JSON.stringify({
                topic: param(params, 'TOPIC'),
                // ntfy fills an empty message with "triggered", so a lone title is the message
                ...(body ? { title, message: body } : { message: title }),
                ...(rich && { markdown: true }),
                priority: PRIORITIES[level],
                ...(url && { click: url }),
                ...(key && { sequence_id: await keyId(key) }),
            }),
            signal,
        })
        await expectOk(response)
    },
}
