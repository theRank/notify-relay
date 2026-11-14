export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
    // Summary for log viewers that display only this field.
    message: string
    path: string
    status: number
    source?: string
    error?: string
    messages?: { delivered: string[]; failed: { channel: string; error: string }[] }[]
}

export type Log = (level: LogLevel, entry: LogEntry) => void

const METHODS = { info: 'log', warn: 'warn', error: 'error' } as const

export const logLine: Log = (level, entry) => console[METHODS[level]](JSON.stringify(entry))

// Preserve queryable fields on platforms with structured logging.
export const logObject: Log = (level, entry) => console[METHODS[level]](entry)
