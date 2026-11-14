import type { Readable } from 'node:stream'

export interface Source {
    readonly stream: ReadableStream<Uint8Array>
    detach(): void
}

// Cancellation must release listeners without destroying the source: STARTTLS reuses the socket,
// and rejected HTTP bodies still need a response. Readable.toWeb destroys the source on cancel.
export function fromNode(source: Readable, onCancel: () => void, failure: (error: Error) => Error = (error) => error): Source {
    let settled = false
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const settle = (finish: () => void) => {
        if (settled) return
        settled = true
        finish()
    }
    const listeners = {
        data: (chunk: Buffer) => {
            if (settled) return
            controller.enqueue(new Uint8Array(chunk))
            if ((controller.desiredSize ?? 0) <= 0) source.pause()
        },
        end: () => settle(() => controller.close()),
        close: () => settle(() => controller.close()),
        error: (error: Error) => settle(() => controller.error(failure(error))),
    }
    const stream = new ReadableStream<Uint8Array>({
        start(started) {
            controller = started
            for (const [event, listener] of Object.entries(listeners)) source.on(event, listener)
        },
        pull: () => void source.resume(),
        cancel() {
            settled = true
            onCancel()
        },
    })
    return {
        stream,
        detach() {
            settled = true
            for (const [event, listener] of Object.entries(listeners)) source.off(event, listener)
        },
    }
}
