import { type AppDeps, handle } from '../app'
import { unsupported } from './method'
import { connector } from './node/connect'
import { ORIGIN } from './origin'

// Payload format 2.0, which Function URLs and HTTP APIs send; REST APIs send 1.0
export interface LambdaEvent {
    version?: string
    rawPath?: string
    rawQueryString?: string
    headers?: Record<string, string>
    body?: string
    isBase64Encoded?: boolean
    requestContext?: { http?: { method?: string } }
}

export interface LambdaResult {
    statusCode: number
    headers: Record<string, string>
    body: string
    isBase64Encoded: false
}

export function lambda(env: object, deps: AppDeps): (event: LambdaEvent) => Promise<LambdaResult> {
    return async (event) => {
        const method = event.requestContext?.http?.method ?? 'GET'
        let response: Response
        try {
            response = unsupported(method) ?? (await handle(toRequest(event, method), env, deps))
        } catch (error) {
            console.error(error)
            response = new Response(null, { status: 500 })
        }
        return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), isBase64Encoded: false }
    }
}

function toRequest(event: LambdaEvent, method: string): Request {
    if (event.version !== '2.0') throw new Error('notify-relay reads payload format 2.0, as Function URLs and HTTP APIs send')
    const url = new URL(`${event.rawPath ?? '/'}?${event.rawQueryString ?? ''}`, ORIGIN)
    const body = !event.body || method === 'GET' || method === 'HEAD' ? {} : { body: event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body }
    return new Request(url, { method, headers: event.headers ?? {}, ...body })
}

export const handler = lambda(process.env, {
    fetch: (input, init) => fetch(input, init),
    connect: connector(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
