import { describe, expect, it } from 'vitest'
import type { Level } from '../src/core/message'
import { RateLimited } from '../src/core/http'
import { bark } from '../src/outbound/bark'
import { seal } from '../src/outbound/bark-cipher'

const params = { KEY: 'device-key-secret' }

function capture(response: Response) {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return response
    }
    const connect = (): never => {
        throw new Error('bark does not connect')
    }
    return { requests, ctx: { fetch, connect, now: () => 1_760_000_000_000, signal: new AbortController().signal, channel: 'phone' } }
}

const ok = () => new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 })

describe('bark', () => {
    it('declares the parameters a channel of this type needs', () => {
        expect(bark.type).toBe('bark')
        expect([...bark.params]).toEqual(['KEY'])
        expect([...(bark.optional ?? [])]).toEqual(['SERVER', 'ENCRYPTION', 'ENCRYPTION_KEY'])
    })

    it('pushes every field to its slot on the official server', async () => {
        const { requests, ctx } = capture(ok())
        await bark.send(
            {
                source: 'github',
                title: 'deploy failed',
                text: 'prod is down',
                rich: '**prod** is down',
                level: 'critical',
                url: 'https://example.com/run',
                key: 'deploy:prod',
                group: 'deploys',
            },
            params,
            ctx,
        )

        expect(requests).toHaveLength(1)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        expect(request.url).toBe('https://api.day.app/push')
        expect(request.headers.get('content-type')).toBe('application/json')
        expect(await request.json()).toEqual({
            device_key: 'device-key-secret',
            title: 'deploy failed',
            body: 'prod is down',
            markdown: '**prod** is down',
            level: 'critical',
            url: 'https://example.com/run',
            group: 'deploys',
            // SHA-256 of the key, base64url: any key fits the 64 bytes APNs allows a collapse ID
            id: 'nx0slVoF-Dv8R-SrmfomsE_VxTxaC9HjeRlmwzdUsks',
        })
    })

    it.each<[Level, string]>([
        ['low', 'passive'],
        ['normal', 'active'],
        ['high', 'timeSensitive'],
        ['critical', 'critical'],
    ])('notifies a %s message as %s', async (level, expected) => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'x', level }, params, ctx)
        expect(((await requests[0]!.json()) as { level: string }).level).toBe(expected)
    })

    it('leaves out the fields a message does not have', async () => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'only a title', level: 'normal' }, params, ctx)
        expect(await requests[0]!.json()).toEqual({ device_key: 'device-key-secret', title: 'only a title', level: 'active' })
    })

    it('replaces by the same id for the same key', async () => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'x', level: 'normal', key: 'k1' }, params, ctx)
        expect(((await requests[0]!.json()) as { id: string }).id).toBe('arnx6499M4j0-dWG9m6Z_VQIDfLERvDlhmiwnAihbdA')
    })

    it.each([
        ['https://bark.example', 'https://bark.example/push'],
        ['https://bark.example/', 'https://bark.example/push'],
        ['https://example.com/bark', 'https://example.com/bark/push'],
    ])('pushes to a server of its own at %s', async (server, expected) => {
        const { requests, ctx } = capture(ok())
        await bark.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, SERVER: server }, ctx)
        expect(requests[0]!.url).toBe(expected)
    })

    it('reports a refused push by status, without the server text, which names the key', async () => {
        const answer = JSON.stringify({ code: 400, message: 'failed to get device token: device-key-secret not found' })
        const { ctx } = capture(new Response(answer, { status: 400 }))
        const error = await bark.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('HTTP 400')
    })

    it('turns 429 into a rate limit', async () => {
        const { ctx } = capture(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
        const error = await bark.send({ source: 'github', title: 'x', level: 'normal' }, params, ctx).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RateLimited)
        expect((error as RateLimited).retryAfterMs).toBe(1000)
    })
})

const PLAINTEXT = '{"title":"x","level":"active"}'

// Decrypts as Bark's app does: the key's and IV's characters as bytes, GCM with the tag at the end
async function open(ciphertext: string, mode: 'GCM' | 'CBC', key: string, iv: string): Promise<unknown> {
    const name = `AES-${mode}`
    const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), name, false, ['decrypt'])
    const bytes = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0))
    const plain = await crypto.subtle.decrypt({ name, iv: new TextEncoder().encode(iv) }, cryptoKey, bytes)
    return JSON.parse(new TextDecoder().decode(plain))
}

describe('bark encryption', () => {
    // Each expected ciphertext comes from another implementation, with the commands Bark's app shows
    it('seals as openssl does with AES-128-CBC and PKCS#7', async () => {
        // printf '%s' "$PLAINTEXT" | openssl enc -aes-128-cbc -K <hex of key> -iv <hex of iv> | base64
        expect(await seal(PLAINTEXT, 'AES128-CBC', '0123456789abcdef', 'fedcba9876543210')).toEqual({
            ciphertext: 'ZmjXuCVa0QLP3WkMGG/abcIaJgpcficTT4Z1REcNtKQ=',
            iv: 'fedcba9876543210',
        })
    })

    it('seals as Node does with AES-256-GCM, the tag appended', async () => {
        // createCipheriv('aes-256-gcm', key, iv): update, final, then getAuthTag(), concatenated
        expect(await seal(PLAINTEXT, 'AES256-GCM', '0123456789abcdef0123456789abcdef', '0123456789ab')).toEqual({
            ciphertext: '4ouTUzem/TnPJ1ufnyYQQjTjuO0t6gsIUOa5fOuFb14pq6xMlIZ0lxLOifBemw==',
            iv: '0123456789ab',
        })
    })

    it('seals with AES-192 too', async () => {
        const { ciphertext } = await seal(PLAINTEXT, 'AES192-GCM', '0123456789abcdef01234567', '0123456789ab')
        expect(ciphertext).toBe('piXOLr9+5vENOKJoQtfSPg/XYRCCNmADEEG/MqcW6CYc+GXjvh49J2N5/bpAGg==')
    })

    it.each([
        ['AES256-GCM', 12],
        ['AES128-CBC', 16],
    ])('draws a fresh IV of the length %s takes, from characters Bark reads as one byte each', async (encryption, length) => {
        const key = encryption.startsWith('AES256') ? '0123456789abcdef0123456789abcdef' : '0123456789abcdef'
        const first = await seal(PLAINTEXT, encryption, key)
        const second = await seal(PLAINTEXT, encryption, key)
        expect(first.iv).toMatch(new RegExp(`^[A-Za-z0-9_-]{${length}}$`))
        expect(second.iv).not.toBe(first.iv)
        expect(second.ciphertext).not.toBe(first.ciphertext)
    })

    it('takes the scheme in any case', async () => {
        const { ciphertext } = await seal(PLAINTEXT, 'aes128-cbc', '0123456789abcdef', 'fedcba9876543210')
        expect(ciphertext).toBe('ZmjXuCVa0QLP3WkMGG/abcIaJgpcficTT4Z1REcNtKQ=')
    })

    it('pushes only the ciphertext, the IV, and the id the server replaces by', async () => {
        const { requests, ctx } = capture(ok())
        const key = '0123456789abcdef0123456789abcdef'
        await bark.send(
            {
                source: 'github',
                title: 'deploy failed',
                text: 'prod is down',
                rich: '**prod** is down',
                level: 'critical',
                url: 'https://example.com/run',
                key: 'k1',
                group: 'deploys',
            },
            { ...params, ENCRYPTION: 'AES256-GCM', ENCRYPTION_KEY: key },
            ctx,
        )

        const body = (await requests[0]!.json()) as Record<string, string>
        expect(Object.keys(body).sort()).toEqual(['ciphertext', 'device_key', 'id', 'iv'])
        expect(body.device_key).toBe('device-key-secret')
        expect(body.id).toBe('arnx6499M4j0-dWG9m6Z_VQIDfLERvDlhmiwnAihbdA')
        // The app's userInfo becomes what it decrypts, so the id goes inside as well
        expect(await open(body.ciphertext!, 'GCM', key, body.iv!)).toEqual({
            title: 'deploy failed',
            body: 'prod is down',
            markdown: '**prod** is down',
            level: 'critical',
            url: 'https://example.com/run',
            group: 'deploys',
            id: 'arnx6499M4j0-dWG9m6Z_VQIDfLERvDlhmiwnAihbdA',
        })
    })

    it('seals a message with CBC as well', async () => {
        const { requests, ctx } = capture(ok())
        const key = '0123456789abcdef'
        await bark.send({ source: 'github', title: 'x', level: 'low' }, { ...params, ENCRYPTION: 'AES128-CBC', ENCRYPTION_KEY: key }, ctx)

        const body = (await requests[0]!.json()) as Record<string, string>
        expect(Object.keys(body).sort()).toEqual(['ciphertext', 'device_key', 'iv'])
        expect(await open(body.ciphertext!, 'CBC', key, body.iv!)).toEqual({ title: 'x', level: 'passive' })
    })

    it.each([
        [{ ENCRYPTION: 'AES256-ECB', ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef' }, 'invalid ENCRYPTION'],
        [{ ENCRYPTION: 'AES256-GCM', ENCRYPTION_KEY: '0123456789abcdef' }, 'ENCRYPTION_KEY must be 32 ASCII characters'],
        [{ ENCRYPTION: 'AES128-GCM', ENCRYPTION_KEY: 'ä'.repeat(8) }, 'ENCRYPTION_KEY must be 16 ASCII characters'],
        [{ ENCRYPTION: 'AES256-GCM' }, 'missing ENCRYPTION_KEY'],
        [{ ENCRYPTION_KEY: '0123456789abcdef' }, 'missing ENCRYPTION'],
    ])('fails without pushing when encryption is set wrong: %o', async (encryption, message) => {
        const { requests, ctx } = capture(ok())
        const error = await bark.send({ source: 'github', title: 'x', level: 'normal' }, { ...params, ...encryption }, ctx).catch((e: unknown) => e)
        expect((error as Error).message).toBe(message)
        expect(requests).toHaveLength(0)
    })
})
