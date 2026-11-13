import type { Outbound } from '../core/deliver'
import { bark } from './bark'
import { discord } from './discord'
import { gmail } from './gmail'
import { loki } from './loki'
import { ntfy } from './ntfy'
import { slack } from './slack'
import { smtp } from './smtp'

export const adapters: Record<string, Outbound> = Object.fromEntries(
    [loki, gmail, smtp, bark, ntfy, slack, discord].map((adapter) => [adapter.type, adapter]),
)
