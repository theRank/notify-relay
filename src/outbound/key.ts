// A channel that replaces by an ID of its own gets a digest of the key, so a key of any length and any
// characters fits the ID's limits, and the same key always maps to the same ID
export async function keyId(key: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
    return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
