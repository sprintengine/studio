import { resolve } from 'node:path'

import type { AgentMcpServerStatus } from '../../shared/skills'

// What each chat CLI last said about its MCP servers, per folder: a Claude
// session's init names every server it loaded with its connection state, and
// Codex reports each server's startup. The config files say which servers are
// set up; only a running CLI can say whether one connected, failed, or is
// waiting for a sign-in, so the picker reads this beside them. Kept per folder
// because a project's servers differ from the next one's.

export type McpServerReport = {
  id: string
  status: AgentMcpServerStatus
  error?: string
  toolCount?: number
}

const reports = new Map<string, Map<string, McpServerReport>>()

const keyOf = (cli: string, cwd: string) => `${cli}\u0000${resolve(cwd)}`

/**
 * `replace` is a whole list (an init names every server), so a server missing
 * from it is gone; without it the reports update one server each.
 */
export function publishMcpServerStatus(input: {
  cli: string
  cwd: string
  servers: readonly McpServerReport[]
  replace?: boolean
}): void {
  const key = keyOf(input.cli, input.cwd)
  const next = input.replace ? new Map<string, McpServerReport>() : new Map(reports.get(key))
  for (const server of input.servers) next.set(server.id, server)
  reports.set(key, next)
}

export function mcpServerStatusFor(cli: string, cwd: string): ReadonlyMap<string, McpServerReport> {
  return reports.get(keyOf(cli, cwd)) ?? new Map()
}

/** For tests. */
export function clearMcpServerStatus(): void {
  reports.clear()
}

const STATUSES: ReadonlySet<string> = new Set<AgentMcpServerStatus>([
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
])

export function isMcpServerStatus(value: unknown): value is AgentMcpServerStatus {
  return typeof value === 'string' && STATUSES.has(value)
}
