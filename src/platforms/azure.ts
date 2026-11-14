// Bundled as CommonJS: the library requires @azure/functions-core, which the worker provides, and in an ES
// module bundle that require fails quietly, leaving the library in a test mode that registers nothing
import { app } from '@azure/functions'
import { logLine } from '../core/log'
import { azure } from './azure/handler'
import { connector } from './node/connect'

// Without streams, the host hands the function a chunked body as an empty one
app.setup({ enableHttpStream: true })

app.http('relay', {
    route: '{*path}',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    handler: azure(process.env, {
        fetch: (input, init) => fetch(input, init),
        connect: connector(),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: logLine,
    }),
})
