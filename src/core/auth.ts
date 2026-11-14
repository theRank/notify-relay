const PREFIX = 'TOKEN_'
// Not under TOKEN_, where a list of channels would be taken for a token
const ALLOW = /^ALLOW_(.+)_CHANNELS$/

export function constantTimeEqual(a: string, b: string): boolean {
    const x = new TextEncoder().encode(a)
    const y = new TextEncoder().encode(b)
    let diff = x.length ^ y.length
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
    }
    return diff === 0
}

function sourceOf(id: string): string {
    return id.toLowerCase().replaceAll('_', '-')
}

export function sources(env: object): string[] {
    return Object.entries(env)
        .filter(([name, value]) => name.startsWith(PREFIX) && typeof value === 'string' && value.trim())
        .map(([name]) => sourceOf(name.slice(PREFIX.length)))
}

// Every token is compared, with no early return
export function authenticate(header: string | null, env: object): string | undefined {
    const presented = /^Bearer (\S+)$/i.exec(header ?? '')?.[1]
    if (!presented) return undefined
    let source: string | undefined
    for (const [name, value] of Object.entries(env)) {
        if (!name.startsWith(PREFIX) || typeof value !== 'string') continue
        for (const token of value.split(/\s+/)) {
            if (token && constantTimeEqual(presented, token) && !source) {
                source = sourceOf(name.slice(PREFIX.length))
            }
        }
    }
    return source
}

export interface Allowlist {
    source: string
    channels: string[]
}

// The lists of channels that sources are held to, one per setting
export function allowlists(env: object): Allowlist[] {
    const lists: Allowlist[] = []
    for (const [name, value] of Object.entries(env)) {
        const id = ALLOW.exec(name)?.[1]
        if (id === undefined) continue
        // A value that is no text is a list all the same, of nothing: the setting is there to hold back
        const names = typeof value === 'string' ? value.split(',').map((channel) => channel.trim()) : []
        lists.push({ source: sourceOf(id), channels: [...new Set(names.filter(Boolean))] })
    }
    return lists
}

// The channels a source may name, or undefined when it is held to no list and may name any
export function allowedChannels(source: string, env: object): string[] | undefined {
    const lists = allowlists(env).filter((list) => list.source === source)
    // Settings that differ only in case name one source, which gets what all of them admit
    return lists[0]?.channels.filter((channel) => lists.every((list) => list.channels.includes(channel)))
}
