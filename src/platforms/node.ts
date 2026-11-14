import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { logLine } from '../core/log'
import { connector } from './node/connect'
import { listener } from './node/listener'

const server = createServer(
    listener(process.env, {
        fetch: (input, init) => fetch(input, init),
        connect: connector(),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: logLine,
    }),
)

server.listen(Number(process.env.PORT ?? 8080), () => {
    console.log(`notify-relay listening on port ${(server.address() as AddressInfo).port}`)
})

// As PID 1 in a container Node has no default signal handlers, so a stop would wait out its grace period
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close())
