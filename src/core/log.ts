export type LogLevel = 'info' | 'warn' | 'error'

// What is said of a request: who sent it where and how it ended. Nothing of the message, nor a secret
export interface LogEntry {
    // The rest in a few words, for a list of lines that shows only this
    message: string
    path: string
    status: number
    source?: string
    error?: string
    messages?: { delivered: string[]; failed: { channel: string; error: string }[] }[]
}

export type Log = (level: LogLevel, entry: LogEntry) => void

const METHODS = { info: 'log', warn: 'warn', error: 'error' } as const

// For platforms whose logs are lines of text
export const logLine: Log = (level, entry) => console[METHODS[level]](JSON.stringify(entry))

// For a platform that keeps what is logged as it is, with fields to query by
export const logObject: Log = (level, entry) => console[METHODS[level]](entry)
