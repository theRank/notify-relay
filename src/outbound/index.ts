import type { Outbound } from '../core/deliver'
import { bark } from './bark'
import { discord } from './discord'
import { feishu } from './feishu'
import { gmail } from './gmail'
import { loki } from './loki'
import { ntfy } from './ntfy'
import { slack } from './slack'
import { smtp } from './smtp'
import { webhook } from './webhook'

export const adapters: Record<string, Outbound> = Object.fromEntries(
    [loki, gmail, smtp, bark, ntfy, slack, discord, feishu, webhook].map((adapter) => [adapter.type, adapter]),
)
