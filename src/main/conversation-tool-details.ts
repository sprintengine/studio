import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type {
  ConversationToolDetail,
  ConversationToolDetailResult,
  ConversationJsonValue,
} from '../shared/conversation-runtime'

const MAX_DETAIL_BYTES = 5 * 1024 * 1024
const HEAD_BYTES = 1024 * 1024

/** The same key-based redaction applies to transcript envelopes and tool details. */
export function redactConversationValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      if (key === 'inputTokens' || key === 'outputTokens' || key === 'totalTokens') return entry
      return /secret|token|api[-_]?key|authorization/i.test(key) ? '[redacted]' : entry
    }),
  ) as T
}

export async function readToolDetail(filePath: string): Promise<ConversationToolDetailResult> {
  try {
    return { ok: true, detail: JSON.parse(await readFile(filePath, 'utf8')) as ConversationToolDetail }
  } catch (error) {
    return {
      ok: false,
      code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable',
      message: 'Tool detail is unavailable.',
    }
  }
}

export async function writeToolDetail(filePath: string, value: ConversationToolDetail): Promise<void> {
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
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, serialized, 'utf8')
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
