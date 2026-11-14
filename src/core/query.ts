export interface Route {
    channels: string[]
    fallback: string[]
    also: string[]
}

export type Routing = Route | { error: string; forbidden?: true }

const GROUPS = ['channels', 'fallback', 'also'] as const

// allowed is the list of channels the sender is held to, when it is held to one
export function parseChannels(url: URL, known: readonly string[], allowed?: readonly string[]): Routing {
    const route: Route = { channels: [], fallback: [], also: [] }
    for (const group of GROUPS) route[group] = list(url.searchParams.get(group))
    if (route.channels.length === 0) return { error: 'channels is required' }

    const groupOf = new Map<string, string>()
    for (const group of GROUPS) {
        for (const name of route[group]) {
            // Before asking whether the channel exists, so that the answer does not tell which others do
            if (allowed && !allowed.includes(name)) return { error: `'${name}' is not a channel this token may use`, forbidden: true }
            if (!known.includes(name)) return { error: `unknown channel '${name}'` }
            const other = groupOf.get(name)
            if (other !== undefined) return { error: `'${name}' is in both ${other} and ${group}` }
            groupOf.set(name, group)
        }
    }
    return route
}

function list(value: string | null): string[] {
    const names = (value ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    return [...new Set(names)]
}
