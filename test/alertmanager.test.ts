import { describe, expect, it } from 'vitest'
import { alertmanager } from '../src/inbound/alertmanager'

interface Alert {
    status?: unknown
    labels?: unknown
    annotations?: unknown
    generatorURL?: unknown
}

const RULE = 'https://grafana.example/alerting/grafana/abc/view?orgId=1'

function alert(host: string, over: Alert = {}): Alert {
    return {
        status: 'firing',
        labels: { alertname: 'HostDown', host },
        annotations: { summary: `${host} stopped reporting`, description: `${host} sent no samples for 10 minutes` },
        generatorURL: RULE,
        ...over,
    }
}

const group = (alerts: Alert[], over: Record<string, unknown> = {}) => ({
    receiver: 'relay',
    status: 'firing',
    alerts,
    groupLabels: { alertname: 'HostDown' },
    commonLabels: { alertname: 'HostDown' },
    commonAnnotations: {},
    externalURL: 'https://grafana.example/',
    version: '4',
    groupKey: '{}:{alertname="HostDown"}',
    truncatedAlerts: 0,
    ...over,
})

const only = (body: unknown) => {
    const drafts = alertmanager.parse(body)
    expect(drafts).toHaveLength(1)
    return drafts[0]!
}

describe('alertmanager', () => {
    it('turns a group into one message, whatever the number of alerts', () => {
        expect(alertmanager.parse(group([alert('a'), alert('b')]))).toEqual([
            {
                title: '[FIRING:2] HostDown',
                text: 'a stopped reporting\na sent no samples for 10 minutes\n\nb stopped reporting\nb sent no samples for 10 minutes',
                level: 'high',
                url: RULE,
                key: '{}:{alertname="HostDown"}',
                group: 'HostDown',
            },
        ])
    })

    it('takes what Grafana sends, ignoring the fields that are its own', () => {
        const body = {
            receiver: 'relay',
            status: 'firing',
            orgId: 1,
            alerts: [
                {
                    status: 'firing',
                    labels: { alertname: 'High memory usage', team: 'blue', zone: 'us-1' },
                    annotations: { description: 'The system has high memory usage', summary: 'This alert was triggered for zone us-1' },
                    startsAt: '2021-10-12T09:51:03.157076+02:00',
                    endsAt: '0001-01-01T00:00:00Z',
                    generatorURL: 'https://play.grafana.org/alerting/1afz29v7z/edit',
                    fingerprint: 'c6eadffa33fcdf37',
                    silenceURL: 'https://play.grafana.org/alerting/silence/new?alertmanager=grafana&matchers=alertname%3DT2',
                    dashboardURL: '',
                    panelURL: '',
                    values: { B: 44.23943737541908, C: 1 },
                    valueString: '[ var=B labels={} value=44.2 ]',
                    imageURL: null,
                },
            ],
            groupLabels: {},
            commonLabels: { team: 'blue' },
            commonAnnotations: {},
            externalURL: 'https://play.grafana.org/',
            version: '1',
            groupKey: '{}:{}',
            truncatedAlerts: 0,
            title: '[FIRING:1]  (blue)',
            state: 'alerting',
            message: '**Firing**\n\nValue: B=44.2',
        }
        expect(alertmanager.parse(body)).toEqual([
            {
                title: '[FIRING:1] High memory usage',
                text: 'This alert was triggered for zone us-1\nThe system has high memory usage',
                level: 'high',
                url: 'https://play.grafana.org/alerting/1afz29v7z/edit',
                key: '{}:{}',
                group: 'High memory usage',
            },
        ])
    })

    it('produces nothing for a group without alerts', () => {
        expect(alertmanager.parse(group([]))).toEqual([])
    })

    describe('title', () => {
        it('says resolved once no alert is firing', () => {
            expect(only(group([alert('a', { status: 'resolved' })])).title).toBe('[RESOLVED] HostDown')
        })

        it('counts the firing alerts only', () => {
            expect(only(group([alert('a', { status: 'resolved' }), alert('b')])).title).toBe('[FIRING:1] HostDown')
        })

        it('reads the name from the alerts, not from what the sender says they share', () => {
            expect(only(group([alert('a')], { commonLabels: undefined, groupLabels: undefined })).title).toBe('[FIRING:1] HostDown')
        })

        it('falls back to the values grouped by when the alerts differ in name', () => {
            const alerts = [alert('a'), alert('a', { labels: { alertname: 'DiskFull', host: 'a' } })]
            const draft = only(group(alerts, { groupLabels: { host: 'a', dc: 'east' } }))
            expect(draft.title).toBe('[FIRING:2] a east')
            expect(draft.group).toBe('a east')
        })

        it('has a name even when nothing names the group', () => {
            const alerts = [alert('a', { labels: {} }), alert('b', { labels: { alertname: 'DiskFull' } })]
            expect(only(group(alerts, { groupLabels: {} })).title).toBe('[FIRING:2] alerts')
        })

        it('stays one line, and short', () => {
            const one = only(group([alert('a', { labels: { alertname: 'Host\r\n  Down\t!' } })]))
            expect(one.title).toBe('[FIRING:1] Host Down !')

            const long = only(group([alert('a', { labels: { alertname: '长'.repeat(500) } })]))
            expect(long.title).toBe(`[FIRING:1] ${'长'.repeat(99)}…`)
        })
    })

    describe('text', () => {
        it('uses whichever of summary and description an alert has', () => {
            const text = (annotations: Record<string, string>) => only(group([alert('a', { annotations })])).text
            expect(text({ summary: 'short' })).toBe('short')
            expect(text({ description: 'long' })).toBe('long')
            expect(text({ summary: ' ', description: 'long' })).toBe('long')
        })

        it('names an alert by the labels that tell it apart when it has neither', () => {
            const alerts = [alert('a', { annotations: {} }), alert('b', { annotations: {} })]
            expect(only(group(alerts)).text).toBe('host=a\n\nhost=b')
        })

        it('names a lone alert, or one among identical ones, by all its labels', () => {
            expect(only(group([alert('a', { annotations: undefined })])).text).toBe('alertname=HostDown, host=a')
            expect(only(group([alert('a', { annotations: {} }), alert('a', { annotations: {} })])).text).toBe(
                'alertname=HostDown, host=a\n\nalertname=HostDown, host=a',
            )
        })

        it('lists firing alerts first, and marks the resolved ones among them', () => {
            const alerts = [alert('a', { status: 'resolved' }), alert('b')]
            expect(only(group(alerts)).text).toBe(
                'b stopped reporting\nb sent no samples for 10 minutes\n\n[resolved] a stopped reporting\na sent no samples for 10 minutes',
            )
        })

        it('marks nothing in a group that is resolved as a whole', () => {
            expect(only(group([alert('a', { status: 'resolved' })])).text).toBe('a stopped reporting\na sent no samples for 10 minutes')
        })

        it('cuts a long alert, by character and not in the middle of one', () => {
            const text = only(group([alert('a', { annotations: { summary: '🚨'.repeat(400) } })])).text!
            expect(text).toBe(`${'🚨'.repeat(299)}…`)
        })

        it('counts the alerts that do not fit instead of listing them', () => {
            const alerts = Array.from({ length: 30 }, (_, i) => alert(`host-${i}`, { annotations: { summary: 'x'.repeat(250) } }))
            const text = only(group(alerts)).text!
            expect([...text].length).toBeLessThanOrEqual(1200)
            expect(text.split('\n\n')).toEqual([...Array.from({ length: 4 }, () => 'x'.repeat(250)), '… and 26 more'])
        })

        // ntfy takes 4,096 bytes, and a character may be four of them
        it('fits the text in bytes as well as in characters', () => {
            const alerts = Array.from({ length: 5 }, (_, i) => alert(`host-${i}`, { annotations: { summary: '🚨'.repeat(290) } }))
            const text = only(group(alerts)).text!
            expect(text.split('\n\n')).toEqual([...Array.from({ length: 3 }, () => '🚨'.repeat(290)), '… and 2 more'])
            expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(3600)
        })

        it('counts the alerts the sender left out too', () => {
            expect(only(group([alert('a', { annotations: { summary: 's' } })], { truncatedAlerts: 3 })).text).toBe('s\n\n… and 3 more')
        })
    })

    describe('level', () => {
        const level = (...alerts: Alert[]) => only(group(alerts)).level
        const severe = (severity: string, status = 'firing') => alert('a', { status, labels: { alertname: 'HostDown', severity } })

        it('is high for a firing alert that states no severity', () => {
            expect(level(alert('a'))).toBe('high')
            expect(level(severe('page'))).toBe('high')
        })

        it('follows the severity label', () => {
            expect(level(severe('critical'))).toBe('critical')
            expect(level(severe('Critical'))).toBe('critical')
            expect(level(severe('warning'))).toBe('high')
            expect(level(severe('info'))).toBe('normal')
        })

        it('is that of the most severe firing alert', () => {
            expect(level(severe('info'), severe('critical'), severe('warning'))).toBe('critical')
            expect(level(severe('info'), alert('b'))).toBe('high')
            expect(level(severe('info'), severe('critical', 'resolved'))).toBe('normal')
        })

        it('is normal once the group is resolved', () => {
            expect(level(severe('critical', 'resolved'))).toBe('normal')
        })
    })

    describe('url', () => {
        const url = (alerts: Alert[], externalURL?: unknown) => only(group(alerts, { externalURL })).url

        it('is the link the alerts share', () => {
            expect(url([alert('a'), alert('b')])).toBe(RULE)
        })

        it('is the sender itself when the alerts link to different places', () => {
            const alerts = [alert('a'), alert('b', { generatorURL: 'https://grafana.example/other' })]
            expect(url(alerts, 'https://grafana.example/')).toBe('https://grafana.example/')
        })

        it('is left out when no link is one a channel can take, as the sender cannot be asked to fix it', () => {
            expect(url([alert('a', { generatorURL: 'http://prometheus:9090/graph?g0.expr=up' })], 'http://alertmanager:9093')).toBeUndefined()
            expect(url([alert('a', { generatorURL: 'https://grafana.example/a b' })])).toBeUndefined()
            expect(url([alert('a', { generatorURL: '' })], '')).toBeUndefined()
            expect(url([alert('a', { generatorURL: undefined })], 7)).toBeUndefined()
        })

        it('falls back to the sender when the shared link is not usable', () => {
            expect(url([alert('a', { generatorURL: 'http://prometheus:9090/graph' })], 'https://alertmanager.example')).toBe(
                'https://alertmanager.example',
            )
        })
    })

    it('leaves the key out when the group has none', () => {
        expect(only(group([alert('a')], { groupKey: undefined }))).not.toHaveProperty('key')
        expect(only(group([alert('a')], { groupKey: '' }))).not.toHaveProperty('key')
    })

    it('rejects what is not an Alertmanager notification', () => {
        for (const body of [null, 'alerts', 42, [alert('a')]]) {
            expect(() => alertmanager.parse(body)).toThrow('body must be a JSON object')
        }
        expect(() => alertmanager.parse({})).toThrow('alerts must be an array')
        expect(() => alertmanager.parse({ title: 'deploy done' })).toThrow('alerts must be an array')
        expect(() => alertmanager.parse({ alerts: {} })).toThrow('alerts must be an array')
        expect(() => alertmanager.parse(group(['a' as Alert]))).toThrow('alerts[0] must be an object')
        expect(() => alertmanager.parse(group([alert('a'), alert('b', { status: 'pending' })]))).toThrow(
            'alerts[1].status must be firing or resolved',
        )
        expect(() => alertmanager.parse(group([alert('a', { status: undefined })]))).toThrow('alerts[0].status must be firing or resolved')
        expect(() => alertmanager.parse(group([alert('a', { labels: ['host'] })]))).toThrow('alerts[0].labels must map names to strings')
        expect(() => alertmanager.parse(group([alert('a', { labels: { host: 1 } })]))).toThrow('alerts[0].labels must map names to strings')
        expect(() => alertmanager.parse(group([alert('a', { annotations: 'none' })]))).toThrow(
            'alerts[0].annotations must map names to strings',
        )
    })

    it('does without the fields around the alerts when they are not what it expects', () => {
        const draft = only(group([alert('a')], { groupLabels: 'none', groupKey: 7, externalURL: null, truncatedAlerts: 'many' }))
        expect(draft).toEqual({
            title: '[FIRING:1] HostDown',
            text: 'a stopped reporting\na sent no samples for 10 minutes',
            level: 'high',
            url: RULE,
            group: 'HostDown',
        })
    })

    it('reads labels named like what every object inherits', () => {
        const labels: unknown = JSON.parse('{"alertname": "toString", "constructor": "x", "__proto__": "y"}')
        const draft = only(group([alert('a', { labels, annotations: {} })]))
        expect(draft.title).toBe('[FIRING:1] toString')
        expect(draft.text).toBe('alertname=toString, constructor=x, __proto__=y')
    })

    it('takes the time a long group needs, not its square', () => {
        const alerts = Array.from({ length: 2000 }, (_, i) => alert(`h${i}`, { annotations: {} }))
        const started = performance.now()
        alertmanager.parse(group(alerts))
        expect(performance.now() - started).toBeLessThan(1000)
    })
})
