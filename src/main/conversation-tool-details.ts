import type { FileHandle } from 'node:fs/promises'
import {
  openConversationAppendFile,
  readConversationStorage,
  writeConversationStorage,
} from './conversation-persistence'
import type {
  ConversationToolDetail,
  ConversationToolDetailResult,
  ConversationJsonValue,
} from '../shared/conversation-runtime'
import { normalizeApiKeySource } from '../shared/conversation/apiKeySource'

const MAX_DETAIL_BYTES = 5 * 1024 * 1024
const HEAD_BYTES = 1024 * 1024
// What a clipped streamed output keeps from its end, beside the head.
const TAIL_BYTES = MAX_DETAIL_BYTES - HEAD_BYTES - 1024
/** Characters of output an event carries as its row preview. */
export const TOOL_PREVIEW_CHARS = 4000

/** Where a tool's streamed output accumulates, beside its JSON detail. */
export function toolOutputStreamPath(detailPath: string): string {
  return detailPath.replace(/\.json$/, '.output')
}

/**
 * The same key-based redaction applies to transcript envelopes and tool details.
 * `apiKeySource` names where a credential came from, never the credential.
 * Redacted, it read back from disk as a source the chat did not know, and the
 * API-key warning showed on every session reloaded from its transcript.
 */
export function redactConversationValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      // A count of tokens is a number and never a credential: usage and the
      // compaction row's before/after sizes all end in `Tokens`.
      if (/tokens$/i.test(key) && typeof entry === 'number') return entry
      if (key === 'apiKeySource') return normalizeApiKeySource(entry) ?? '[redacted]'
      return /secret|token|api[-_]?key|authorization/i.test(key) ? '[redacted]' : entry
    }),
  ) as T
}

/**
 * A tool's detail. Output that streamed in is kept in its own append-only file
 * and the JSON records an empty output; the two are joined here.
 */
export async function readToolDetail(workspaceRoot: string, filePath: string): Promise<ConversationToolDetailResult> {
  try {
    const detail = JSON.parse(
      (await readConversationStorage(workspaceRoot, filePath, MAX_DETAIL_BYTES)).toString('utf8'),
    ) as ConversationToolDetail
    if (detail.output === '') {
      const streamed = await readConversationStorage(
        workspaceRoot,
        toolOutputStreamPath(filePath),
        MAX_DETAIL_BYTES + 1024,
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (streamed) detail.output = streamed.toString('utf8')
    }
    return { ok: true, detail }
  } catch (error) {
    return {
      ok: false,
      code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable',
      message: 'Tool detail is unavailable.',
    }
  }
}

export async function writeToolDetail(
  workspaceRoot: string,
  filePath: string,
  value: ConversationToolDetail,
): Promise<void> {
  const detail = redactConversationValue(value)
  let serialized = JSON.stringify(detail)
  if (Buffer.byteLength(serialized) > MAX_DETAIL_BYTES) {
    detail.clipped = true
    // Keep JSON valid: clip the largest field, including escaped-string overhead,
    // and preserve both the beginning and the most recent output.
    let budget = MAX_DETAIL_BYTES - 1024
    while (Buffer.byteLength(serialized) > MAX_DETAIL_BYTES) {
      const field =
        Buffer.byteLength(JSON.stringify(detail.output)) >= Buffer.byteLength(JSON.stringify(detail.input))
          ? 'output'
          : 'input'
      detail[field] = clipValue(detail[field], budget)
      serialized = JSON.stringify(detail)
      budget = Math.floor(budget * 0.8)
    }
  }
  await writeConversationStorage(workspaceRoot, filePath, serialized)
}

function clipValue(value: ConversationJsonValue, budget: number): string {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  const head = Math.min(HEAD_BYTES, Math.floor(budget / 5))
  return (
    bytes.subarray(0, head).toString('utf8') +
    '\n[clipped]\n' +
    bytes.subarray(-Math.max(1, budget - head)).toString('utf8')
  )
}

/**
 * A tool's output as it streams: each chunk is appended to the output file
 * once, and the row preview is the latest text. Re-sending and re-writing the
 * whole output per chunk made a long command quadratic in its own output. Past
 * the detail budget the file keeps its head, and `finish` rewrites it once as
 * head plus the most recent output, the way a clipped detail always reads.
 */
export class ToolOutputStream {
  tail = ''
  chars = 0
  totalBytes = 0
  clipped = false
  private fileBytes = 0
  private recent: Buffer[] = []
  private recentBytes = 0
  private writes: Promise<void> = Promise.resolve()
  private file: Promise<FileHandle> | null = null
  private failed = false

  constructor(
    private readonly workspaceRoot: string,
    readonly path: string,
  ) {}

  append(text: string): void {
    if (!text) return
    this.chars += text.length
    this.tail = (this.tail + text).slice(-TOOL_PREVIEW_CHARS)
    const bytes = Buffer.from(text)
    this.totalBytes += bytes.length
    this.recent.push(bytes)
    this.recentBytes += bytes.length
    while (this.recent.length > 1 && this.recentBytes - this.recent[0].length >= TAIL_BYTES)
      this.recentBytes -= this.recent.shift()!.length
    const room = MAX_DETAIL_BYTES - this.fileBytes
    if (room < bytes.length) this.clipped = true
    if (room <= 0) return
    const chunk = bytes.length > room ? bytes.subarray(0, room) : bytes
    this.fileBytes += chunk.length
    this.writes = this.writes.then(async () => {
      if (this.failed) return
      try {
        this.file ??= openConversationAppendFile(this.workspaceRoot, this.path)
        await (await this.file).writeFile(chunk)
      } catch {
        // The preview still streams; only the full output is lost.
        this.failed = true
      }
    })
  }

  /** Every chunk appended so far is on disk. */
  settled(): Promise<void> {
    return this.writes
  }

  /** Close the file, clipping it to head and tail if it overflowed. */
  async finish(): Promise<void> {
    await this.writes
    const file = this.file
    this.file = null
    if (file) await file.then((handle) => handle.close()).catch(() => undefined)
    if (!this.clipped || this.failed || !file) return
    const head = (await readConversationStorage(this.workspaceRoot, this.path, MAX_DETAIL_BYTES)).subarray(
      0,
      HEAD_BYTES,
    )
    const tail = Buffer.concat(this.recent).subarray(-TAIL_BYTES)
    await writeConversationStorage(
      this.workspaceRoot,
      this.path,
      `${head.toString('utf8')}\n[clipped]\n${tail.toString('utf8')}`,
    )
  }
}
