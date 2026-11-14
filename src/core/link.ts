export function refuseLink(value: unknown): string | undefined {
    if (typeof value !== 'string' || !URL.canParse(value) || new URL(value).protocol !== 'https:') return 'url must be https'
    // URL parsers strip whitespace and controls, but channels receive the original string.
    if (/[\s\0-\x1f\x7f]/.test(value)) return 'url must not contain whitespace or control characters'
    return undefined
}
