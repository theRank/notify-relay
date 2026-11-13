import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'
import type { Level } from '../core/message'

const COLORS: Record<Level, number> = { low: 0x95a5a6, normal: 0x3498db, high: 0xe67e22, critical: 0xe74c3c }

const SUPPRESS_NOTIFICATIONS = 1 << 12

export const discord: Outbound = {
    type: 'discord',
    params: ['URL'],
    async send(message, params, { fetch, signal }) {
        const { title, text, rich, level, url } = message
        const description = rich ?? (text && escape(text))
        // Without wait, Discord answers 204 even for a message it did not save
        const target = new URL(param(params, 'URL'))
        target.searchParams.set('wait', 'true')
        const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                embeds: [{ title: escape(title), ...(description && { description }), ...(url && { url }), color: COLORS[level] }],
                ...(level === 'low' && { flags: SUPPRESS_NOTIFICATIONS }),
            }),
            signal,
        })
        await expectOk(response)
    },
}

// Discord renders Markdown in an embed's title and description, and shows any punctuation after a
// backslash as it is. Links are left whole, as an escape in one would break it
function escape(text: string): string {
    return text
        .split(/(https?:\/\/[^\s<]+)/)
        .map((part, i) =>
            i % 2
                ? part
                : part
                      .replace(/[\\*_~`|<[]/g, '\\$&')
                      .replace(/^(\s*)([>#+-])/gm, '$1\\$2')
                      .replace(/^(\s*\d+)\./gm, '$1\\.'),
        )
        .join('')
}
