import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk, RateLimited, retryAfterMs } from '../core/http'

const SERVER = 'https://api.telegram.org'
const MAX_REASON = 100

export const telegram: Outbound = {
    type: 'telegram',
    params: ['TOKEN', 'CHAT'],
    optional: ['THREAD', 'SERVER'],
    async send(message, params, { fetch, signal }) {
        const { title, text, rich, level, url } = message
        const heading = url ? `<a href="${escape(url, true)}">${escape(title)}</a>` : escape(title)
        // A rich message renders Markdown, tables included, but a client older than it shows none of it, so
        // a message without rich goes as one any client shows. Markdown is not parsed within a block tag,
        // which keeps the title as written
        const [method, content] = rich
            ? ['sendRichMessage', { rich_message: { markdown: `<p><b>${heading}</b></p>\n\n${rich}` } }]
            : [
                  'sendMessage',
                  {
                      text: text ? `<b>${heading}</b>\n${escape(text)}` : `<b>${heading}</b>`,
                      parse_mode: 'HTML',
                      link_preview_options: { is_disabled: true },
                  },
              ]
        const response = await fetch(endpoint(params, method), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                chat_id: param(params, 'CHAT'),
                ...(params.THREAD !== undefined && { message_thread_id: topic(params.THREAD) }),
                ...content,
                ...(level === 'low' && { disable_notification: true }),
            }),
            signal,
        })
        const answer = (await response.json().catch(() => undefined)) as
            | { ok?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } }
            | undefined
        if (response.ok && answer?.ok === true) return
        // ok decides, as the Bot API has it. Telegram's own server also sets the status to error_code, and
        // sends Retry-After with retry_after, but a proxy may answer 200 or drop the header
        if (answer?.ok === false) {
            const code = typeof answer.error_code === 'number' ? answer.error_code : response.status
            if (code === 429) {
                const seconds = answer.parameters?.retry_after
                throw new RateLimited(
                    typeof seconds === 'number' && seconds >= 0 ? seconds * 1000 : retryAfterMs(response.headers.get('retry-after')),
                )
            }
            const why = typeof answer.description === 'string' ? ` (${reason(answer.description)})` : ''
            throw new Error(`HTTP ${code}${why}`)
        }
        if (response.ok) throw new Error('unexpected answer')
        await expectOk(response)
    },
}

// fetch names the whole URL in its error, token and all, so a SERVER it cannot use is caught first
function endpoint(params: Record<string, string>, method: string): URL {
    let server: URL
    try {
        server = new URL(params.SERVER ?? SERVER)
    } catch {
        throw new Error('SERVER must be an http(s) URL')
    }
    if (server.protocol !== 'https:' && server.protocol !== 'http:') throw new Error('SERVER must be an http(s) URL')
    if (server.username !== '' || server.password !== '') throw new Error('SERVER must not hold a user or password')
    server.pathname = `${server.pathname.replace(/\/+$/, '')}/bot${param(params, 'TOKEN')}/${method}`
    return server
}

function topic(value: string): number {
    if (!/^[1-9]\d*$/.test(value)) throw new Error('THREAD must be a topic ID')
    return Number(value)
}

// Telegram's reasons name what went wrong, never the message, after the status's own words
function reason(description: string): string {
    const words = description.replace(/^[A-Z][a-z]+(?: [A-Z][a-z]+)*: /, '')
    return words.length > MAX_REASON ? `${words.slice(0, MAX_REASON)}…` : words
}

function escape(text: string, attribute = false): string {
    const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    return attribute ? escaped.replaceAll('"', '&quot;') : escaped
}
