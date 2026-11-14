import type { IncomingMessage, ServerResponse } from 'node:http'
import { type AppDeps, handle } from '../../app'
import { unsupported } from '../method'
import { ORIGIN } from '../origin'
import { fromNode, type Source } from './readable'

export function listener(env: object, deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async (req, res) => {
        const method = req.method ?? 'GET'
        const refused = unsupported(method)
        const body = refused || method === 'GET' || method === 'HEAD' ? undefined : fromNode(req, () => {})
        let response: Response
        try {
            response = refused ?? (await handle(toRequest(req, method, body), env, deps))
        } catch (error) {
            console.error(error)
            response = new Response(null, { status: 500 })
        }
        res.statusCode = response.status
        for (const [name, value] of response.headers) res.setHeader(name, value)
        res.end(new Uint8Array(await response.arrayBuffer()))
        // Node drains an unread body only if nothing ever listened to it, and a paused one stalls the connection
        body?.detach()
        req.resume()
    }
}

function toRequest(req: IncomingMessage, method: string, body: Source | undefined): Request {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
        for (const item of [value ?? []].flat()) headers.append(name, item)
    }
    return new Request(new URL(req.url ?? '/', ORIGIN), { method, headers, ...(body && { body: body.stream, duplex: 'half' }) })
}
