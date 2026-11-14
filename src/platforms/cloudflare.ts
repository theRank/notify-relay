import { connect } from 'cloudflare:sockets'
import { handle } from '../app'
import { logObject } from '../core/log'

export default {
    async fetch(request, env, _ctx): Promise<Response> {
        return handle(request, env, {
            fetch: (input, init) => fetch(input, init),
            connect,
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            log: logObject,
        })
    },
} satisfies ExportedHandler<Env>
