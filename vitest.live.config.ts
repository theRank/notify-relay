import { execFileSync, spawnSync } from 'node:child_process'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { ntfyTopic, readLive, relaySettings } from './test/live/settings'

const live = readLive()

const { GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
const repository = GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}` : undefined

// The relay under test is the Worker in this process, a container of LIVE_IMAGE started here with the
// Worker's settings, or a deployment at LIVE_RELAY_URL that holds them already
const { LIVE_IMAGE: image, LIVE_RELAY_URL: deployed, LIVE_RELAY_TOKEN } = process.env
if (image && deployed) throw new Error('set LIVE_IMAGE or LIVE_RELAY_URL, not both')
// A deployment is reachable by anyone, so its token is a secret rather than a fixed one
if (deployed && !LIVE_RELAY_TOKEN) throw new Error('LIVE_RELAY_URL needs LIVE_RELAY_TOKEN')
if (deployed && !live.LIVE_NTFY_TOPIC) throw new Error('LIVE_RELAY_URL needs LIVE_NTFY_TOPIC, the topic the deployment publishes to')
const token = deployed ? LIVE_RELAY_TOKEN! : 'nr_live'
const relay = relaySettings(live, token, ntfyTopic(live))
const relayUrl = deployed ?? (image ? await start(image, relay) : undefined)
const target = deployed ? (process.env.LIVE_TARGET ?? new URL(deployed).host) : image ? 'Docker' : 'Workers'

async function start(image: string, settings: Record<string, string>): Promise<string> {
    // Passed by name, so the values stay out of the process list
    const names = Object.keys(settings).flatMap((name) => ['--env', name])
    const id = execFileSync('docker', ['run', '--detach', '--rm', '--publish', '127.0.0.1::8080', ...names, image], {
        env: { ...process.env, ...settings },
        encoding: 'utf8',
    }).trim()
    process.on('exit', (code) => {
        if (code !== 0) spawnSync('docker', ['logs', id], { stdio: 'inherit' })
        spawnSync('docker', ['stop', id])
    })
    const origin = `http://${execFileSync('docker', ['port', id, '8080/tcp'], { encoding: 'utf8' }).split('\n')[0]}`
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200))) {
        if (await fetch(`${origin}/healthz`).then(() => true, () => false)) return origin
    }
    throw new Error(`${image} did not start listening`)
}

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
                bindings: {
                    ...relay,
                    ...(relayUrl && { LIVE_RELAY_URL: relayUrl }),
                    LIVE_TOKEN: token,
                    LIVE_TARGET: target,
                    LIVE_IMAP_HOST: live.LIVE_IMAP_HOST,
                    LIVE_IMAP_USER: live.LIVE_IMAP_USER,
                    LIVE_IMAP_PASSWORD: live.LIVE_IMAP_PASSWORD,
                    LIVE_COMMIT: GITHUB_SHA ?? 'local',
                    LIVE_COMMIT_URL: repository ? `${repository}/commit/${GITHUB_SHA}` : 'local',
                    LIVE_RUN_URL: repository ? `${repository}/actions/runs/${GITHUB_RUN_ID}` : 'local',
                },
            },
        }),
    ],
    test: { include: ['test/live/*.test.ts'] },
})
