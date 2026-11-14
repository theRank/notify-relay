const PREFIX = 'TOKEN_'
// Keep allowlists outside TOKEN_ so they cannot authenticate a request.
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

// Compare every token to avoid revealing the match's position through an early return.
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

export function allowlists(env: object): Allowlist[] {
    const lists: Allowlist[] = []
    for (const [name, value] of Object.entries(env)) {
        const id = ALLOW.exec(name)?.[1]
        if (id === undefined) continue
        // Fail closed when a configured allowlist is not a string.
        const names = typeof value === 'string' ? value.split(',').map((channel) => channel.trim()) : []
        lists.push({ source: sourceOf(id), channels: [...new Set(names.filter(Boolean))] })
    }
    return lists
}

// undefined means unrestricted; [] denies all channels.
export function allowedChannels(source: string, env: object): string[] | undefined {
    const lists = allowlists(env).filter((list) => list.source === source)
    // Intersect lists whose names normalize to the same source.
    return lists[0]?.channels.filter((channel) => lists.every((list) => list.channels.includes(channel)))
}
