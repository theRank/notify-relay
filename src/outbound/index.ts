import type { Outbound } from '../core/deliver'
import { bark } from './bark'
import { gmail } from './gmail'
import { loki } from './loki'
import { smtp } from './smtp'

export const adapters: Record<string, Outbound> = Object.fromEntries(
    [loki, gmail, smtp, bark].map((adapter) => [adapter.type, adapter]),
)
