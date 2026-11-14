// For platforms that build the Request themselves: these methods are ones a Request refuses to carry, and
// no endpoint takes them, so they are answered here rather than left to fail as an error of the relay's
const UNSUPPORTED = new Set(['CONNECT', 'TRACE', 'TRACK'])

export function unsupported(method: string): Response | undefined {
    return UNSUPPORTED.has(method.toUpperCase()) ? new Response(null, { status: 501 }) : undefined
}
