import { createWriteStream, type WriteStream } from 'fs'
import { chmod, mkdir, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'

import type { McpConnectionMetadata, McpToolResult } from './mcp-socket-server'

export const STUDIO_GATEWAY_AUDIT_FILENAME = 'sprintengine-studio-mcp-audit.jsonl'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_BACKUPS = 3
const SAFE_IDENTIFIER_KEYS = new Set([
  'workspaceId',
  'agentId',
  'automationId',
  'runId',
  'taskId',
  'path',
  'relativePath',
  'sourceRelativePath',
  'epicId',
  'id',
  'status',
  'type',
  'slug',
  'repo',
  'issue',
  'numericId',
  'previousNumericId',
  'replacements',
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
  /**
   * Queue one record. Returns at once: the line is built synchronously (so it
   * describes the call as it was) and written behind any earlier ones, in order,
   * through one open append stream. A failed write is logged, never thrown — an
   * audit that cannot be written must not fail the mutation it describes.
   */
  record(input: {
    connection: McpConnectionMetadata
    tool: string
    durationMs: number
    args: Record<string, unknown>
    result?: McpToolResult
    error?: unknown
  }): void
  /** Settles once every record queued so far is on disk. */
  flush(): Promise<void>
  /** Flush, then close the stream. A later record opens a new one. */
  close(): Promise<void>
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

  // One stream, opened on the first record and reopened after a rotation or a
  // failure. `size` mirrors the file's length, so deciding to rotate costs no
  // stat per line.
  let open: { path: string; stream: WriteStream; size: number } | null = null
  let queue: Promise<void> = Promise.resolve()

  const closeStream = async (): Promise<void> => {
    const current = open
    open = null
    if (current) await endStream(current.stream)
  }

  const writeLine = async (line: string): Promise<void> => {
    const directory = options.resolveUserDataDir()
    const path = join(directory, STUDIO_GATEWAY_AUDIT_FILENAME)
    const bytes = Buffer.byteLength(line)
    if (open && open.path !== path) await closeStream()
    if (open && open.size + bytes > maxBytes) {
      await closeStream()
      await rotate(path, backups)
    }
    if (!open) {
      await mkdir(directory, { recursive: true })
      let size = await fileSize(path)
      if (size > 0 && size + bytes > maxBytes) {
        await rotate(path, backups)
        size = 0
      }
      open = { path, stream: await openAppendStream(path), size }
    }
    const target = open
    await writeToStream(target.stream, line)
    target.size += bytes
  }

  return {
    record(input): void {
      let line: string
      try {
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
        line = `${JSON.stringify(record)}\n`
      } catch (error) {
        options.log?.(`Studio MCP mutation audit write failed: ${message(error)}`)
        return
      }
      queue = queue.then(() =>
        writeLine(line).catch(async (error: unknown) => {
          options.log?.(`Studio MCP mutation audit write failed: ${message(error)}`)
          // Drop the stream: the next record reopens it rather than writing
          // into one that has already failed.
          await closeStream().catch(() => undefined)
        }),
      )
    },
    flush(): Promise<void> {
      return queue
    },
    close(): Promise<void> {
      queue = queue.then(() => closeStream().catch(() => undefined))
      return queue
    },
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function openAppendStream(path: string): Promise<WriteStream> {
  const stream = createWriteStream(path, { flags: 'a', encoding: 'utf8', mode: 0o600 })
  await new Promise<void>((resolve, reject) => {
    stream.once('open', () => resolve())
    stream.once('error', reject)
  })
  // `mode` applies only when the file is created; one that predates it is
  // tightened here.
  if (process.platform !== 'win32') await chmod(path, 0o600)
  return stream
}

function writeToStream(stream: WriteStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, (error) => (error ? reject(error) : resolve()))
  })
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed) {
      resolve()
      return
    }
    stream.once('error', () => resolve())
    stream.end(() => resolve())
  })
}

function safeIdentifiers(value: unknown): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  collectSafeIdentifiers(value, result, 0)
  return result
}

function collectSafeIdentifiers(
  value: unknown,
  result: Record<string, string | number | boolean>,
  depth: number,
): void {
  if (!value || typeof value !== 'object' || depth > 3) return
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 10)) collectSafeIdentifiers(entry, result, depth + 1)
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      SAFE_IDENTIFIER_KEYS.has(key) &&
      (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
    ) {
      result[key] = typeof entry === 'string' ? entry.slice(0, 256) : entry
    } else if (entry && typeof entry === 'object') {
      collectSafeIdentifiers(entry, result, depth + 1)
    }
  }
}

// Identity written into the record. Local-socket fields stay advisory (anything
// with filesystem access could claim them); the tailnet fields do not — the
// listener authenticated the device before dispatch, so `deviceId`/`peerNode`
// answer "which paired machine did this" for a remote mutation.
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
    deviceId: trim(connection.deviceId),
    deviceName: trim(connection.deviceName),
    peerNode: trim(connection.peerNode),
  }
}

function errorCode(error: unknown, result: McpToolResult | undefined): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code.slice(0, 128)
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

async function rotate(path: string, backups: number): Promise<void> {
  await unlink(`${path}.${backups}`).catch(() => undefined)
  for (let index = backups - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => undefined)
  }
  await rename(path, `${path}.1`).catch(() => undefined)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
