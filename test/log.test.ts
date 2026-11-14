import { afterEach, describe, expect, it, vi } from 'vitest'
import { logLine } from '../src/core/log'

describe('logLine', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each([
        ['info', 'log'],
        ['warn', 'warn'],
        ['error', 'error'],
    ] as const)('writes an entry of level %s as one line of JSON with console.%s', (level, method) => {
        const written = vi.spyOn(console, method).mockImplementation(() => {})
        logLine(level, { path: '/webhook', status: 200, source: 'github' })
        expect(written.mock.calls).toEqual([['{"path":"/webhook","status":200,"source":"github"}']])
    })
})
