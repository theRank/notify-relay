import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk, RateLimited } from '../core/http'
import type { Level } from '../core/message'

const TEMPLATES: Record<Level, string> = { low: 'grey', normal: 'blue', high: 'orange', critical: 'red' }

// The API supplies no retry delay for this code; use one second below.
const RATE_LIMITED = 11232

export const feishu: Outbound = {
    type: 'feishu',
    params: ['URL'],
    optional: ['SECRET'],
    async send(message, params, { fetch, now, signal }) {
        const { title, text, rich, level, url } = message
        const elements = rich
            ? [{ tag: 'markdown', content: rich }]
            : text
              ? [{ tag: 'div', text: { tag: 'plain_text', content: text } }]
              : []
        const card = {
            schema: '2.0',
            // The chat list shows the summary
            config: { summary: { content: title } },
            ...(url && { card_link: { url } }),
            header: { title: { tag: 'plain_text', content: title }, template: TEMPLATES[level] },
            ...(elements.length > 0 && { body: { elements } }),
        }
        const signature = params.SECRET !== undefined ? await sign(Math.floor(now() / 1000), params.SECRET) : {}
        const response = await fetch(param(params, 'URL'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...signature, msg_type: 'interactive', card }),
            signal,
        })
        // Feishu answers 200 for a post it refused, with the reason in code
        const { code } = ((await response.json().catch(() => undefined)) ?? {}) as { code?: unknown }
        if (response.ok && code === 0) return
        if (code === RATE_LIMITED) throw new RateLimited(1000)
        if (typeof code === 'number' && code !== 0) throw new Error(`code ${code}`)
        await expectOk(response)
        throw new Error('unexpected answer')
    },
}

async function sign(timestamp: number, secret: string): Promise<{ timestamp: string; sign: string }> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(`${timestamp}\n${secret}`),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    )
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array()))
    return { timestamp: String(timestamp), sign: btoa(String.fromCharCode(...mac)) }
}
