import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

import type { McpConnectionMetadata, McpToolResult } from './mcp-socket-server'

export const STUDIO_GATEWAY_AUDIT_FILENAME = 'sprintengine-studio-mcp-audit.jsonl'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_BACKUPS = 3
const SAFE_IDENTIFIER_KEYS = new Set([
  'workspaceId', 'agentId', 'automationId', 'runId', 'sprintId', 'taskId', 'artifactId',
  'path', 'relativePath', 'sourceRelativePath', 'epicId', 'id', 'status', 'type', 'slug', 'repo',
  'issue', 'numericId', 'previousNumericId', 'replacements',
])

export type GatewayAuditRecord = {
  timestamp: string
  connection: McpConnectionMetadata
  tool: string
  durationMs: number
  outcome: 'success' | 'failure'
  errorCode?: string
  targets: Record<string, string | number | boolean>
  affected: Record<string, string | number | boolean>
}

export type GatewayAuditStore = {
  record(input: {
    connection: McpConnectionMetadata
    tool: string
    durationMs: number
    args: Record<string, unknown>
    result?: McpToolResult
    error?: unknown
  }): void
}

export function createGatewayAuditStore(options: {
  resolveUserDataDir: () => string
  maxBytes?: number
  backups?: number
  now?: () => Date
  log?: (message: string) => void
}): GatewayAuditStore {
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES)
  const backups = Math.max(1, options.backups ?? DEFAULT_BACKUPS)
  const now = options.now ?? (() => new Date())

  return {
    record(input): void {
      try {
        const directory = options.resolveUserDataDir()
        mkdirSync(directory, { recursive: true })
        const path = join(directory, STUDIO_GATEWAY_AUDIT_FILENAME)
        const code = errorCode(input.error, input.result)
        const record: GatewayAuditRecord = {
          timestamp: now().toISOString(),
          connection: normalizeConnection(input.connection),
          tool: input.tool,
          durationMs: Math.max(0, Math.round(input.durationMs)),
          outcome: input.error || input.result?.isError ? 'failure' : 'success',
          ...(code ? { errorCode: code } : {}),
          targets: safeIdentifiers(input.args),
          // A browser tool's result is the page's word (evaluate returns
          // arbitrary JSON); nothing in it may pose as an app identifier.
          affected: input.tool.startsWith('browser.')
            ? {}
            : safeIdentifiers(input.result?.structuredContent ?? canonicalContent(input.result)),
        }
        const line = `${JSON.stringify(record)}\n`
        rotateIfNeeded(path, Buffer.byteLength(line), maxBytes, backups)
        appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
        if (process.platform !== 'win32') chmodSync(path, 0o600)
      } catch (error) {
        options.log?.(`Studio MCP mutation audit write failed: ${message(error)}`)
      }
    },
  }
}

export function safeIdentifiers(value: unknown): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  collectSafeIdentifiers(value, result, 0)
  return result
}

function collectSafeIdentifiers(
  value: unknown,
  result: Record<string, string | number | boolean>,
  depth: number
): void {
  if (!value || typeof value !== 'object' || depth > 3) return
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 10)) collectSafeIdentifiers(entry, result, depth + 1)
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SAFE_IDENTIFIER_KEYS.has(key) && (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')) {
      result[key] = typeof entry === 'string' ? entry.slice(0, 256) : entry
    } else if (entry && typeof entry === 'object') {
      collectSafeIdentifiers(entry, result, depth + 1)
    }
  }
}

// Identity written into the record. Local-socket fields stay advisory (anything
// with filesystem access could claim them); the tailnet fields do not — the
// listener authenticated the device before dispatch, so `deviceId`/`peerNode`
// answer "which paired machine did this" for a remote mutation (MC-2162).
function normalizeConnection(connection: McpConnectionMetadata): McpConnectionMetadata {
  const trim = (value: string | undefined): string | undefined => value?.trim().slice(0, 256) || undefined
  return {
    kind:
      connection.kind === 'studio-agent'
        ? 'studio-agent'
        : connection.kind === 'remote-tailnet'
          ? 'remote-tailnet'
          : 'external-local',
    workspaceId: trim(connection.workspaceId),
    agentId: trim(connection.agentId),
    agentName: trim(connection.agentName),
    cliId: trim(connection.cliId),
    sprintRunId: trim(connection.sprintRunId),
    deviceId: trim(connection.deviceId),
    deviceName: trim(connection.deviceName),
    peerNode: trim(connection.peerNode),
  }
}

function errorCode(error: unknown, result: McpToolResult | undefined): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code.slice(0, 128)
  const structured = result?.structuredContent
  if (structured && typeof structured === 'object') {
    const nested = structured.error
    if (nested && typeof nested === 'object' && 'code' in nested && typeof nested.code === 'string') {
      return nested.code.slice(0, 128)
    }
    if (typeof structured.code === 'string') return structured.code.slice(0, 128)
  }
  if (result?.isError) {
    try {
      const parsed = JSON.parse(firstText(result)) as { error?: { code?: unknown } }
      if (typeof parsed.error?.code === 'string') return parsed.error.code.slice(0, 128)
    } catch {
      // Canonical non-JSON error content falls through to the bounded generic code.
    }
  }
  return error ? 'internal_error' : result?.isError ? 'tool_error' : undefined
}

function canonicalContent(result: McpToolResult | undefined): unknown {
  try {
    return JSON.parse(firstText(result))
  } catch {
    return undefined
  }
}

/** The first text block's text; image blocks (browser screenshots) carry no JSON. */
function firstText(result: McpToolResult | undefined): string {
  const first = result?.content[0]
  return first && first.type === 'text' ? first.text : ''
}

function rotateIfNeeded(path: string, incomingBytes: number, maxBytes: number, backups: number): void {
  if (!existsSync(path) || statSync(path).size + incomingBytes <= maxBytes) return
  const oldest = `${path}.${backups}`
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let index = backups - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`)
  }
  renameSync(path, `${path}.1`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
