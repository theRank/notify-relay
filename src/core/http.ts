export class BadRequest extends Error {}

export class RateLimited extends Error {
    readonly retryAfterMs: number

    constructor(retryAfterMs: number) {
        super('rate limited')
        this.retryAfterMs = retryAfterMs
    }
}

export async function expectOk(response: Response): Promise<void> {
    if (response.ok) return
    if (response.status === 429) throw new RateLimited(retryAfterMs(response.headers.get('retry-after')))
    throw new Error(`HTTP ${response.status}`)
}

export function retryAfterMs(value: string | null): number {
    if (value === null || value.trim() === '') return Infinity
    const seconds = Number(value)
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Infinity
}
