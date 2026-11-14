import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'

const PREFIX = 'whsec_'
const MIN_SECRET_BYTES = 24

export const webhook: Outbound = {
    type: 'webhook',
    params: ['URL'],
    optional: ['SECRET', 'TOKEN'],
    async send(message, params, { fetch, now, signal }) {
        // Omit other channels' recipients from the forwarded payload.
        const { source, title, text, rich, level, url, key, group } = message
        const body = JSON.stringify({ source, title, text, rich, level, url, key, group })
        const signed = params.SECRET !== undefined ? await sign(params.SECRET, Math.floor(now() / 1000), body) : {}
        const response = await fetch(param(params, 'URL'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(params.TOKEN !== undefined && { authorization: `Bearer ${params.TOKEN}` }),
                ...signed,
            },
            body,
            // A redirect could turn POST into a bodyless GET and falsely appear successful.
            redirect: 'manual',
            signal,
        })
        await expectOk(response)
    },
}

async function sign(secret: string, timestamp: number, body: string): Promise<Record<string, string>> {
    const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`
    return {
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': await signature(secret, id, timestamp, body),
    }
}

// Standard Webhooks signing format: https://www.standardwebhooks.com
export async function signature(secret: string, id: string, timestamp: number, body: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', decode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))
    return `v1,${btoa(String.fromCharCode(...mac))}`
}

function decode(secret: string): Uint8Array<ArrayBuffer> {
    let bytes: Uint8Array<ArrayBuffer>
    try {
        bytes = Uint8Array.from(atob(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret), (c) => c.charCodeAt(0))
    } catch {
        throw new Error('SECRET must be base64')
    }
    if (bytes.length < MIN_SECRET_BYTES) throw new Error('SECRET must be at least 24 bytes')
    return bytes
}
