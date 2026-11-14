// Why a value cannot be a message's url, or undefined when it can
export function refuseLink(value: unknown): string | undefined {
    if (typeof value !== 'string' || !URL.canParse(value) || new URL(value).protocol !== 'https:') return 'url must be https'
    // A URL parser drops these around a link and within it, so one that parses may still be no link to a
    // channel, which gets it as written
    if (/[\s\0-\x1f\x7f]/.test(value)) return 'url must not contain whitespace or control characters'
    return undefined
}
