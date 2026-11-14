const NAMES = [
    'LIVE_LOKI_URL',
    'LIVE_LOKI_USER',
    'LIVE_LOKI_TOKEN',
    'LIVE_SMTP_HOST',
    'LIVE_SMTP_USER',
    'LIVE_SMTP_PASSWORD',
    'LIVE_SMTP_FROM',
    'LIVE_SMTP_TO',
    'LIVE_GMAIL_CLIENT_ID',
    'LIVE_GMAIL_CLIENT_SECRET',
    'LIVE_GMAIL_REFRESH_TOKEN',
    'LIVE_GMAIL_FROM',
    'LIVE_GMAIL_TO',
    'LIVE_IMAP_HOST',
    'LIVE_IMAP_USER',
    'LIVE_IMAP_PASSWORD',
] as const

// Personal destinations are optional; an unset channel is skipped. The ntfy topic has a default.
const OPTIONAL = [
    'LIVE_BARK_KEY',
    'LIVE_BARK_ENCRYPTION',
    'LIVE_BARK_ENCRYPTION_KEY',
    'LIVE_NTFY_TOPIC',
    'LIVE_SLACK_URL',
    'LIVE_DISCORD_URL',
    'LIVE_FEISHU_URL',
    'LIVE_FEISHU_SECRET',
    'LIVE_TELEGRAM_TOKEN',
    'LIVE_TELEGRAM_CHAT',
] as const

export type Live = Record<(typeof NAMES)[number], string> & Partial<Record<(typeof OPTIONAL)[number], string>>

export function readLive(env: NodeJS.ProcessEnv = process.env): Live {
    const missing = NAMES.filter((name) => !env[name])
    if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
    return Object.fromEntries([...NAMES, ...OPTIONAL].filter((name) => env[name]).map((name) => [name, env[name]!])) as Live
}

// Use an unguessable topic per run, or share LIVE_NTFY_TOPIC with an existing deployment.
export function ntfyTopic(live: Live): string {
    return live.LIVE_NTFY_TOPIC ?? `notify-relay-live-${crypto.randomUUID()}`
}

export function relaySettings(live: Live, token: string, topic: string): Record<string, string> {
    const smtp = (id: string, port: string) => ({
        [`CHANNEL_${id}_TYPE`]: 'smtp',
        [`CHANNEL_${id}_HOST`]: live.LIVE_SMTP_HOST,
        [`CHANNEL_${id}_PORT`]: port,
        [`CHANNEL_${id}_USER`]: live.LIVE_SMTP_USER,
        [`CHANNEL_${id}_PASSWORD`]: live.LIVE_SMTP_PASSWORD,
        [`CHANNEL_${id}_FROM`]: live.LIVE_SMTP_FROM,
        [`CHANNEL_${id}_TO`]: live.LIVE_SMTP_TO,
    })
    return {
        CHANNEL_LOKI_TYPE: 'loki',
        CHANNEL_LOKI_URL: live.LIVE_LOKI_URL,
        CHANNEL_LOKI_USER: live.LIVE_LOKI_USER,
        CHANNEL_LOKI_TOKEN: live.LIVE_LOKI_TOKEN,
        ...smtp('SMTP_587', '587'),
        ...smtp('SMTP_465', '465'),
        CHANNEL_GMAIL_TYPE: 'gmail',
        CHANNEL_GMAIL_CLIENT_ID: live.LIVE_GMAIL_CLIENT_ID,
        CHANNEL_GMAIL_CLIENT_SECRET: live.LIVE_GMAIL_CLIENT_SECRET,
        CHANNEL_GMAIL_REFRESH_TOKEN: live.LIVE_GMAIL_REFRESH_TOKEN,
        CHANNEL_GMAIL_FROM: live.LIVE_GMAIL_FROM,
        CHANNEL_GMAIL_TO: live.LIVE_GMAIL_TO,
        ...(live.LIVE_BARK_KEY && { CHANNEL_BARK_TYPE: 'bark', CHANNEL_BARK_KEY: live.LIVE_BARK_KEY }),
        ...(live.LIVE_SLACK_URL && { CHANNEL_SLACK_TYPE: 'slack', CHANNEL_SLACK_URL: live.LIVE_SLACK_URL }),
        ...(live.LIVE_DISCORD_URL && { CHANNEL_DISCORD_TYPE: 'discord', CHANNEL_DISCORD_URL: live.LIVE_DISCORD_URL }),
        ...(live.LIVE_FEISHU_URL && {
            CHANNEL_FEISHU_TYPE: 'feishu',
            CHANNEL_FEISHU_URL: live.LIVE_FEISHU_URL,
            ...(live.LIVE_FEISHU_SECRET && { CHANNEL_FEISHU_SECRET: live.LIVE_FEISHU_SECRET }),
        }),
        ...(live.LIVE_TELEGRAM_TOKEN &&
            live.LIVE_TELEGRAM_CHAT && {
                CHANNEL_TELEGRAM_TYPE: 'telegram',
                CHANNEL_TELEGRAM_TOKEN: live.LIVE_TELEGRAM_TOKEN,
                CHANNEL_TELEGRAM_CHAT: live.LIVE_TELEGRAM_CHAT,
            }),
        CHANNEL_NTFY_TYPE: 'ntfy',
        CHANNEL_NTFY_TOPIC: topic,
        // ntfy stores the body for readback but does not verify the webhook signature.
        CHANNEL_WEBHOOK_TYPE: 'webhook',
        CHANNEL_WEBHOOK_URL: `https://ntfy.sh/${topic}`,
        CHANNEL_WEBHOOK_SECRET: `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`,
        ...(live.LIVE_BARK_KEY &&
            live.LIVE_BARK_ENCRYPTION &&
            live.LIVE_BARK_ENCRYPTION_KEY && {
                CHANNEL_BARK_SEALED_TYPE: 'bark',
                CHANNEL_BARK_SEALED_KEY: live.LIVE_BARK_KEY,
                CHANNEL_BARK_SEALED_ENCRYPTION: live.LIVE_BARK_ENCRYPTION,
                CHANNEL_BARK_SEALED_ENCRYPTION_KEY: live.LIVE_BARK_ENCRYPTION_KEY,
            }),
        TOKEN_LIVE: token,
    }
}

const FORMATS: Record<string, (settings: Record<string, string>) => string> = {
    env: (settings) => Object.entries(settings).map(([name, value]) => `${name}=${value}\n`).join(''),
    json: (settings) => `${JSON.stringify(settings, null, 4)}\n`,
    lambda: (settings) => `${JSON.stringify({ Variables: settings }, null, 4)}\n`,
}

if (import.meta.main) {
    const format = FORMATS[process.argv[2] ?? '']
    const { LIVE_RELAY_TOKEN: token, LIVE_NTFY_TOPIC: topic } = process.env
    if (!format || !token || !topic) {
        console.error('usage: LIVE_RELAY_TOKEN=nr_... LIVE_NTFY_TOPIC=... node test/live/settings.ts env|json|lambda')
        process.exit(2)
    }
    process.stdout.write(format(relaySettings(readLive(), token, topic)))
}
