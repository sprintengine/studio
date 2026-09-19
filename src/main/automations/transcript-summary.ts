import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { forEachJsonlRow } from '../jsonl'

/**
 * Derive an automation run summary from a Claude Code JSONL transcript: the text
 * of the agent's last assistant message.
 *
 * The transcript path arrives from an agent-state hook reporter and is therefore
 * UNTRUSTED. This module is the containment boundary: it accepts only an
 * absolute `.jsonl` path to a regular file within {@link MAX_TRANSCRIPT_BYTES},
 * streams it row by row, and never throws — every rejection returns `undefined`
 * so a missing, hostile, or unreadable transcript degrades to the caller's
 * generic summary instead of failing a run finalize.
 *
 * Pure and engine-free by contract (no import of engine.ts).
 */

/**
 * Size cap applied before reading. This is an abuse guard, not a working limit:
 * real transcripts get big (a long local session measured 83MB / 1,420 rows, and
 * streamed in 167ms), so a tight cap would silently drop the summary for exactly
 * the long runs that most need one. Set well above observed sizes; past it the
 * file is treated as not-a-transcript rather than streamed.
 */
export const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024

/** Summary length cap. Longer text is truncated with an ellipsis. */
export const MAX_TRANSCRIPT_SUMMARY_LENGTH = 500

type TranscriptRow = {
  type?: unknown
  isSidechain?: unknown
  message?: { id?: unknown; content?: unknown } | null
}

/**
 * Text of the last assistant message in the transcript at `transcriptPath`,
 * truncated to {@link MAX_TRANSCRIPT_SUMMARY_LENGTH}. Returns `undefined` when
 * the path is not an absolute `.jsonl` file, the file is missing, not a regular
 * file, over the size cap, unreadable, or carries no assistant text.
 */
export async function readTranscriptSummary(transcriptPath: string): Promise<string | undefined> {
  if (!isAcceptableTranscriptPath(transcriptPath)) return undefined
  try {
    const stats = await stat(transcriptPath)
    // isFile() also rejects a directory or a FIFO, which would otherwise stall
    // the streaming read forever.
    if (!stats.isFile() || stats.size > MAX_TRANSCRIPT_BYTES) return undefined
  } catch {
    return undefined
  }

  // A multi-content-block assistant turn is written as SEVERAL rows sharing one
  // `message.id`, so the
  // last message is the last id group, not the last row. Rows of a group are
  // contiguous, so tracking the current group is enough.
  let groupId: string | null = null
  let groupTexts: string[] = []
  try {
    await forEachJsonlRow(transcriptPath, (row) => {
      const texts = assistantTextBlocks(row as TranscriptRow)
      if (!texts) return
      const id = messageId(row as TranscriptRow)
      if (id !== null && id === groupId) {
        groupTexts.push(...texts)
        return
      }
      groupId = id
      groupTexts = texts
    })
  } catch {
    return undefined
  }

  const summary = groupTexts.join('\n').trim()
  if (!summary) return undefined
  return summary.length > MAX_TRANSCRIPT_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_TRANSCRIPT_SUMMARY_LENGTH - 1).trimEnd()}…`
    : summary
}

function isAcceptableTranscriptPath(transcriptPath: unknown): transcriptPath is string {
  return (
    typeof transcriptPath === 'string' &&
    transcriptPath.endsWith('.jsonl') &&
    !transcriptPath.includes('\0') &&
    isAbsolute(transcriptPath)
  )
}

function messageId(row: TranscriptRow): string | null {
  const id = row.message?.id
  return typeof id === 'string' && id ? id : null
}

/**
 * Text blocks of an assistant row, or `undefined` when the row is not assistant
 * text we can use. Sidechain rows are skipped: a Task subagent's final message
 * is its own, not the run's summary.
 */
function assistantTextBlocks(row: TranscriptRow): string[] | undefined {
  if (row.type !== 'assistant' || row.isSidechain === true) return undefined
  const content = row.message?.content
  if (typeof content === 'string') return content ? [content] : undefined
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string' && text) texts.push(text)
  }
  return texts.length > 0 ? texts : undefined
}
