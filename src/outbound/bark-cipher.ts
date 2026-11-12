// Bark's end-to-end encryption, as its app decrypts it (Model/Algorithm.swift): AES with the characters of
// the key and the IV as bytes, GCM with the tag appended or CBC with PKCS#7, in base64. ECB, which the app
// offers too, is left out: WebCrypto has none, and it gives equal blocks away
const MODES: Record<string, { name: string; ivLength: number }> = {
    GCM: { name: 'AES-GCM', ivLength: 12 },
    CBC: { name: 'AES-CBC', ivLength: 16 },
}

export async function seal(plaintext: string, encryption: string, key: string, iv?: string): Promise<{ ciphertext: string; iv: string }> {
    const scheme = /^AES(128|192|256)-(GCM|CBC)$/i.exec(encryption)
    if (!scheme) throw new Error('invalid ENCRYPTION')
    const keyLength = Number(scheme[1]) / 8
    const mode = MODES[scheme[2]!.toUpperCase()]!
    const keyBytes = new TextEncoder().encode(key)
    // The app counts characters and AES takes bytes, so only one byte per character satisfies both
    if (key.length !== keyLength || keyBytes.length !== keyLength) throw new Error(`ENCRYPTION_KEY must be ${keyLength} ASCII characters`)

    const nonce = iv ?? randomIv(mode.ivLength)
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, mode.name, false, ['encrypt'])
    const sealed = await crypto.subtle.encrypt({ name: mode.name, iv: new TextEncoder().encode(nonce) }, cryptoKey, new TextEncoder().encode(plaintext))
    return { ciphertext: base64(new Uint8Array(sealed)), iv: nonce }
}

// A fresh IV per push, never the one saved in the app, since GCM under a repeated IV leaks plaintext. Its
// characters are base64url, 6 random bits each
function randomIv(length: number): string {
    return base64(crypto.getRandomValues(new Uint8Array((length * 3) / 4)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
}

function base64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}
