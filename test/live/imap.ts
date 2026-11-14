import { connect } from 'cloudflare:sockets'

export interface Mailbox {
    host: string
    user: string
    password: string
}

// Exclude sent copies and aggregate folders so only received mail proves delivery.
const SKIPPED = ['\\Noselect', '\\NonExistent', '\\Sent', '\\Drafts', '\\Trash', '\\All', '\\Flagged', '\\Important']

export async function arrival(mailbox: Mailbox, subject: string): Promise<string[] | undefined> {
    const socket = connect({ hostname: mailbox.host, port: 993 }, { secureTransport: 'on', allowHalfOpen: false })
    try {
        const session = new Session(socket)
        if (!(await session.line()).startsWith('* OK')) throw new Error('IMAP greeting refused')
        await session.command(`LOGIN ${quote(mailbox.user)} ${quote(mailbox.password)}`)
        for (const line of await session.command('LIST "" "*"')) {
            const list = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i.exec(line)
            if (!list) continue
            const [, attributes = '', name] = list
            const flags = attributes.split(' ')
            if (flags.some((flag) => SKIPPED.some((skipped) => skipped.toLowerCase() === flag.toLowerCase()))) continue
            const examined = await session.command(`EXAMINE ${name}`)
            const exists = Math.max(0, ...examined.map((reply) => Number(/^\* (\d+) EXISTS$/i.exec(reply)?.[1] ?? 0)))
            if (exists === 0) continue
            // SEARCH goes through an index that can lag minutes behind delivery, so read the newest subjects
            const fetched = await session.command(`FETCH ${Math.max(1, exists - 19)}:* (BODY.PEEK[HEADER.FIELDS (SUBJECT)])`)
            if (decoded(fetched).includes(subject)) return flags
        }
        return undefined
    } finally {
        await socket.close().catch(() => {})
    }
}

function quote(value: string): string {
    if (/["\\\r\n]/.test(value)) throw new Error('IMAP value needs a literal')
    return `"${value}"`
}

function decoded(lines: string[]): string {
    return lines
        .join('\r\n')
        .replace(/\r\n(?=[ \t])/g, '')
        .replace(/\?=[ \t]+=\?/g, '?==?')
        .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, text: string) => decoder.decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0))))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class Session {
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>
    private readonly decoder = new TextDecoder()
    private buffer = ''
    private tag = 0

    constructor(socket: Socket) {
        this.reader = socket.readable.getReader()
        this.writer = socket.writable.getWriter()
    }

    async command(line: string): Promise<string[]> {
        const tag = `a${++this.tag}`
        await this.writer.write(encoder.encode(`${tag} ${line}\r\n`))
        const untagged: string[] = []
        for (;;) {
            const reply = await this.line()
            if (!reply.startsWith(`${tag} `)) {
                untagged.push(reply)
                continue
            }
            const status = reply.slice(tag.length + 1).split(' ', 1)[0]!
            if (status.toUpperCase() !== 'OK') throw new Error(`IMAP ${status} on ${line.split(' ', 1)[0]}`)
            return untagged
        }
    }

    async line(): Promise<string> {
        for (;;) {
            const end = this.buffer.indexOf('\r\n')
            if (end >= 0) {
                const line = this.buffer.slice(0, end)
                this.buffer = this.buffer.slice(end + 2)
                return line
            }
            const { value, done } = await this.reader.read()
            if (done) throw new Error('IMAP connection closed')
            this.buffer += this.decoder.decode(value, { stream: true })
        }
    }
}
