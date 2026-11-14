import { BadRequest } from '../core/http'
import { LEVELS, type Draft, type Inbound, type Level } from '../core/message'

const FIELDS = new Set(['title', 'text', 'rich', 'level', 'url', 'key', 'group', 'to'])

export const webhook: Inbound = {
    parse(body) {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new BadRequest('body must be a JSON object')
        }
        const input = body as Record<string, unknown>
        for (const field of Object.keys(input)) {
            if (!FIELDS.has(field)) throw new BadRequest(`unknown field '${field}'`)
        }

        const draft: Draft = { title: title(input.title), level: level(input.level) }
        for (const field of ['text', 'rich', 'key', 'group'] as const) {
            const value = optionalString(input, field)
            if (value) draft[field] = value
        }
        if (input.url !== undefined) draft.url = https(input.url)
        if (input.to !== undefined) draft.to = recipients(input.to)
        return [draft]
    },
}

function title(value: unknown): string {
    if (value === undefined) throw new BadRequest('title is required')
    if (typeof value !== 'string') throw new BadRequest('title must be a string')
    if (value.trim() === '') throw new BadRequest('title is required')
    if (/[\r\n]/.test(value)) throw new BadRequest('title must be one line')
    return value
}

function level(value: unknown): Level {
    if (value === undefined) return 'normal'
    const found = LEVELS.find((known) => known === value)
    if (!found) throw new BadRequest(`level must be one of ${LEVELS.join(', ')}`)
    return found
}

function https(value: unknown): string {
    if (typeof value !== 'string' || !URL.canParse(value) || new URL(value).protocol !== 'https:') throw new BadRequest('url must be https')
    // A URL parser drops these around a link and within it, so one that parses may still be no link to a
    // channel, which gets it as written
    if (/[\s\0-\x1f\x7f]/.test(value)) throw new BadRequest('url must not contain whitespace or control characters')
    return value
}

function recipients(value: unknown): Record<string, string> {
    const valid =
        typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string')
    if (!valid) throw new BadRequest('to must map channel names to recipients')
    return value as Record<string, string>
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
    const value = input[field]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new BadRequest(`${field} must be a string`)
    return value
}
