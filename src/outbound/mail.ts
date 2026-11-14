import { param } from '../core/channels'
import type { Message } from '../core/message'

// base64 has no '_', so no part can contain the boundary
const BOUNDARY = '_notify-relay_'
// RFC 2047 caps encoded-word lines at 76 characters; 39 bytes make 64 after 'Subject: '
const WORD_BYTES = 39
// ASCII only: an SMTP envelope without SMTPUTF8 carries nothing else
const PART = String.raw`(?:(?![<>",@])[!-~])+`
const ADDRESS = new RegExp(`^${PART}@${PART}$`)
const DOMAIN = new RegExp(`^\\*@${PART}$`)

export interface Addressing {
    headers: string[]
    from: string | undefined
    to: string[]
}

export function refuseRecipients(value: string, params: Record<string, string>): string | undefined {
    const mailboxes = parseAddresses(value)
    if (mailboxes === undefined) return 'must be one or more email addresses'
    if (params.ALLOW_TO === undefined) return 'custom recipients not enabled'
    const allowed = parseAllowlist(params.ALLOW_TO)
    if (allowed !== undefined && !mailboxes.every((mailbox) => allowed(mailbox.address))) return 'recipient not allowed'
    return undefined
}

export function recipients(params: Record<string, string>, named: string | undefined): string {
    if (params.ALLOW_TO !== undefined && parseAllowlist(params.ALLOW_TO) === undefined) throw new Error('invalid ALLOW_TO')
    if (named === undefined) return param(params, 'TO')
    const refused = refuseRecipients(named, params)
    if (refused !== undefined) throw new Error(refused)
    return named
}

export function addressing(to: string, from: string | undefined): Addressing {
    const recipients = mailboxes(to, 'TO')
    const sender = from === undefined ? undefined : mailboxes(from, 'FROM')
    if (sender !== undefined && sender.length !== 1) throw new Error('invalid FROM')
    const headers = [`To: ${recipients.map((mailbox) => mailbox.header).join(',\r\n ')}`]
    if (sender?.[0]) headers.unshift(`From: ${sender[0].header}`)
    return { headers, from: sender?.[0]?.address, to: recipients.map((mailbox) => mailbox.address) }
}

export function mime(headers: string[], message: Message): string {
    const head = [...headers, `Subject: ${words(message.title)}`, 'MIME-Version: 1.0']
    const plain = part('text/plain', message.text || message.title)
    if (message.rich === undefined) return [...head, plain].join('\r\n')
    return [
        ...head,
        `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
        '',
        `--${BOUNDARY}`,
        plain,
        `--${BOUNDARY}`,
        part('text/html', message.rich),
        `--${BOUNDARY}--`,
    ].join('\r\n')
}

export function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

export function base64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}

function part(type: string, content: string): string {
    return [
        `Content-Type: ${type}; charset=UTF-8`,
        'Content-Transfer-Encoding: base64',
        '',
        (base64(utf8(content)).match(/.{1,76}/g) ?? []).join('\r\n'),
    ].join('\r\n')
}

function mailboxes(value: string, param: string): { header: string; address: string }[] {
    const parsed = parseAddresses(value)
    if (parsed === undefined) throw new Error(`invalid ${param}`)
    return parsed.map(({ name, address }) => {
        if (name === '') return { header: address, address }
        if (/^[\x20-\x7e]*$/.test(name)) return { header: `"${name.replace(/[\\"]/g, '\\$&')}" <${address}>`, address }
        return { header: `${words(name)}\r\n <${address}>`, address }
    })
}

function parseAddresses(value: string): { name: string; address: string }[] | undefined {
    const parsed: { name: string; address: string }[] = []
    for (const item of split(value)) {
        const trimmed = item.trim()
        if (ADDRESS.test(trimmed)) {
            parsed.push({ name: '', address: trimmed })
            continue
        }
        const mailbox = parseMailbox(trimmed)
        if (mailbox === undefined) return undefined
        parsed.push(mailbox)
    }
    return parsed
}

// `name <address>`, cut at the last '<' rather than matched by a pattern: one that tries every length of
// the name takes time that grows with the square of a long run of spaces
function parseMailbox(value: string): { name: string; address: string } | undefined {
    const open = value.lastIndexOf('<')
    if (open < 0 || !value.endsWith('>')) return undefined
    const address = value.slice(open + 1, -1)
    const raw = value.slice(0, open).trimEnd()
    // A line break may fold the header before the address, but a name holds none
    if (!ADDRESS.test(address) || /[\r\n\u2028\u2029]/.test(raw)) return undefined
    const name = unquote(raw)
    return name === undefined ? undefined : { name, address }
}

function parseAllowlist(value: string): ((address: string) => boolean) | undefined {
    const patterns = value.split(',').map((pattern) => pattern.trim().toLowerCase())
    if (!patterns.every((pattern) => pattern === '*' || DOMAIN.test(pattern) || ADDRESS.test(pattern))) return undefined
    return (address) => {
        const lower = address.toLowerCase()
        const domain = `*${lower.slice(lower.lastIndexOf('@'))}`
        return patterns.some((pattern) => pattern === '*' || pattern === lower || pattern === domain)
    }
}

function split(value: string): string[] {
    const items: string[] = []
    let quoted = false
    let start = 0
    for (let i = 0; i < value.length; i++) {
        if (quoted && value[i] === '\\') i++
        else if (value[i] === '"') quoted = !quoted
        else if (!quoted && value[i] === ',') {
            items.push(value.slice(start, i))
            start = i + 1
        }
    }
    return [...items, value.slice(start)]
}

function unquote(name: string): string | undefined {
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(name)?.[1]
    if (quoted !== undefined) return quoted.replace(/\\(.)/g, '$1')
    return name.includes('"') ? undefined : name
}

function words(text: string): string {
    const chunks = ['']
    let size = 0
    for (const char of text) {
        const bytes = utf8(char).length
        if (size + bytes > WORD_BYTES) {
            chunks.push('')
            size = 0
        }
        chunks[chunks.length - 1] += char
        size += bytes
    }
    return chunks.map((chunk) => `=?UTF-8?B?${base64(utf8(chunk))}?=`).join('\r\n ')
}
