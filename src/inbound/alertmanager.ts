import { BadRequest } from '../core/http'
import { refuseLink } from '../core/link'
import { LEVELS, type Draft, type Inbound, type Level } from '../core/message'

// The sender cannot shorten what it sends, so the adapter does, to what every channel type takes
const NAME_MAX = 100
const ALERT_MAX = 300
const TEXT_MAX = 1200
// Room kept in TEXT_MAX for the line that counts the alerts left out
const COUNT_MAX = 30

const SEVERITIES: Record<string, Level> = { critical: 'critical', warning: 'high', info: 'normal' }

type Labels = Record<string, string>

interface Alert {
    firing: boolean
    labels: Labels
    annotations: Labels
    link: unknown
}

// The webhook notification of Alertmanager, which Grafana sends too with fields of its own added. A
// notification is about a group of alerts and is sent again whenever one of them changes, so it becomes
// one message: one per alert would repeat every alert of the group each time
export const alertmanager: Inbound = {
    parse(body) {
        if (!isObject(body)) throw new BadRequest('body must be a JSON object')
        if (!Array.isArray(body.alerts)) throw new BadRequest('alerts must be an array')
        const alerts = body.alerts.map(readAlert)
        if (alerts.length === 0) return []

        const firing = alerts.filter((alert) => alert.firing)
        const name = nameOf(alerts, body.groupLabels)
        const draft: Draft = {
            title: firing.length > 0 ? `[FIRING:${firing.length}] ${name}` : `[RESOLVED] ${name}`,
            text: describe(firing, alerts, body.truncatedAlerts),
            level: levelOf(firing),
        }
        const url = linkOf(alerts, body.externalURL)
        if (url !== undefined) draft.url = url
        if (typeof body.groupKey === 'string' && body.groupKey !== '') draft.key = body.groupKey
        draft.group = name
        return [draft]
    },
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLabels(value: unknown): value is Labels {
    return isObject(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function readAlert(value: unknown, index: number): Alert {
    const at = `alerts[${index}]`
    if (!isObject(value)) throw new BadRequest(`${at} must be an object`)
    if (value.status !== 'firing' && value.status !== 'resolved') throw new BadRequest(`${at}.status must be firing or resolved`)
    return {
        firing: value.status === 'firing',
        labels: readLabels(value.labels, `${at}.labels`),
        annotations: readLabels(value.annotations, `${at}.annotations`),
        link: value.generatorURL,
    }
}

function readLabels(value: unknown, at: string): Labels {
    if (value === undefined) return {}
    if (!isLabels(value)) throw new BadRequest(`${at} must map names to strings`)
    return value
}

// The name the alerts share, read from them rather than from what the sender says they have in common;
// failing that, what they were grouped by
function nameOf(alerts: Alert[], groupLabels: unknown): string {
    const first = own(alerts[0]!.labels, 'alertname')
    const shared = alerts.every((alert) => own(alert.labels, 'alertname') === first) ? first : undefined
    const grouped = isLabels(groupLabels) ? Object.values(groupLabels).join(' ') : ''
    return cut(oneLine(shared ?? ''), NAME_MAX) || cut(oneLine(grouped), NAME_MAX) || 'alerts'
}

// A label may be named like what every object inherits, such as constructor
function own(labels: Labels, name: string): string | undefined {
    return Object.hasOwn(labels, name) ? labels[name] : undefined
}

function oneLine(value: string): string {
    return value.replace(/[\s\0-\x1f\x7f]+/g, ' ').trim()
}

// By character, so that none is cut in half
function cut(value: string, max: number): string {
    const characters = [...value]
    return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : value
}

function describe(firing: Alert[], alerts: Alert[], truncated: unknown): string {
    const telling = tellingLabels(alerts)
    const resolved = alerts.filter((alert) => !alert.firing)
    // Firing first; in a group that still fires, the resolved ones say so
    const all = [...firing, ...resolved]

    const listed: string[] = []
    let length = 0
    for (const alert of all) {
        const mark = !alert.firing && firing.length > 0 ? '[resolved] ' : ''
        const entry = cut(mark + describeAlert(alert, telling), ALERT_MAX)
        const added = [...entry].length + (listed.length > 0 ? 2 : 0)
        if (length + added > TEXT_MAX - COUNT_MAX) break
        listed.push(entry)
        length += added
    }
    const left = all.length - listed.length + (typeof truncated === 'number' && truncated > 0 ? Math.floor(truncated) : 0)
    if (left > 0) listed.push(`… and ${left} more`)
    return listed.join('\n\n')
}

function describeAlert(alert: Alert, telling: Set<string>): string {
    const said = ['summary', 'description'].map((name) => own(alert.annotations, name)?.trim()).filter((value) => value)
    if (said.length > 0) return said.join('\n')
    const labels = Object.entries(alert.labels)
    const apart = labels.filter(([name]) => telling.has(name))
    return (apart.length > 0 ? apart : labels).map(([name, value]) => `${name}=${value}`).join(', ')
}

// The labels that tell the alerts apart: those not every alert has with the same value
function tellingLabels(alerts: Alert[]): Set<string> {
    const seen = new Map<string, { value: string; count: number }>()
    const telling = new Set<string>()
    for (const alert of alerts) {
        for (const [name, value] of Object.entries(alert.labels)) {
            const known = seen.get(name)
            if (!known) seen.set(name, { value, count: 1 })
            else if (known.value === value) known.count++
            else telling.add(name)
        }
    }
    for (const [name, { count }] of seen) {
        if (count < alerts.length) telling.add(name)
    }
    return alerts.length > 1 ? telling : new Set()
}

// A resolved group is no longer urgent; a firing one is as urgent as its most severe alert, and an alert
// that states no severity is still an alert
function levelOf(firing: Alert[]): Level {
    if (firing.length === 0) return 'normal'
    const ranks = firing.map((alert) => {
        const severity = own(alert.labels, 'severity')?.toLowerCase() ?? ''
        return LEVELS.indexOf(Object.hasOwn(SEVERITIES, severity) ? SEVERITIES[severity]! : 'high')
    })
    return LEVELS[Math.max(...ranks)]!
}

// The link the alerts share, else the sender's own. One that is not a clean https link is left out
// rather than refused, as nobody can change what the sender puts there
function linkOf(alerts: Alert[], external: unknown): string | undefined {
    const first = alerts[0]!.link
    const shared = alerts.every((alert) => alert.link === first) ? first : undefined
    return [shared, external].find((link): link is string => refuseLink(link) === undefined)
}
