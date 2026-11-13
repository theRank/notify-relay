import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'

export const slack: Outbound = {
    type: 'slack',
    params: ['URL'],
    async send(message, params, { fetch, signal }) {
        const { title, text, rich, url } = message
        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: title } },
            // Incoming webhooks refuse a markdown block, so rich is taken as Slack's own mrkdwn
            ...(rich
                ? [{ type: 'section', text: { type: 'mrkdwn', text: rich } }]
                : text
                  ? [{ type: 'section', text: { type: 'plain_text', text } }]
                  : []),
            // A link element without text shows the URL as it is, with nothing to escape
            ...(url ? [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url }] }] }] : []),
        ]
        const response = await fetch(param(params, 'URL'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // The notification shows the fallback text, which Slack reads as mrkdwn
            body: JSON.stringify({ text: escape(title), blocks }),
            signal,
        })
        await expectOk(response)
    },
}

function escape(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
