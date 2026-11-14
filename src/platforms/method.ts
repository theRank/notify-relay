// Reject methods forbidden by Request with 405 before constructing it, avoiding a spurious 500.
const UNSUPPORTED = new Set(['CONNECT', 'TRACE', 'TRACK'])

export function unsupported(method: string): Response | undefined {
    return UNSUPPORTED.has(method.toUpperCase()) ? new Response(null, { status: 501 }) : undefined
}
