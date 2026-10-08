import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import type { ConversationImportSource } from '../../shared/ipc/conversation-import'
import { recordTime } from './imported-transcript'

/** A session a CLI saved, as a scan finds it: enough to list it, not its history. */
export type ScannedSession = {
  source: ConversationImportSource
  sessionId: string
  /** The transcript file the history is read from. */
  path: string
  folderPath: string
  title: string | null
  firstPrompt: string | null
  startedAt: number
  updatedAt: number
}

/**
 * The parsed JSON lines of a byte range of a file. A range that starts inside
 * a line drops that partial line, and one that ends inside a line drops the
 * rest, so only whole records come back; a line that is not JSON is skipped.
 */
export async function readJsonLinesWindow(
  path: string,
  start: number,
  length: number,
): Promise<Array<Record<string, unknown>>> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start > 0) lines.shift()
    if (bytesRead === length) lines.pop()
    return lines.flatMap((line) => {
      const record = parseRecord(line)
      return record ? [record] : []
    })
  } finally {
    await handle.close()
  }
}

/** Every record of a JSON-lines file, in order, without holding the file in memory. */
export async function* readJsonLines(path: string): AsyncGenerator<Record<string, unknown>> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const record = parseRecord(line)
      if (record) yield record
    }
  } finally {
    // Closing the interface leaves its stream open: a reader that stops early
    // (a scan wants the first few records) would hold the file's descriptor.
    lines.close()
    input.destroy()
  }
}

/**
 * When the newest of `records` was written, by the times the CLI stamped on
 * them, or null when none carries one. A session's last activity is read off
 * its records rather than its file's modified time, which a copied home, a
 * restored backup or a sync tool moves without the session doing anything.
 */
export function newestRecordTime(records: ReadonlyArray<Record<string, unknown>>): number | null {
  let newest: number | null = null
  for (const record of records) {
    const at = recordTime(record.timestamp)
    if (at !== null && (newest === null || at > newest)) newest = at
  }
  return newest
}

/** Whether a path is a folder that exists here, which a chat can work in. */
export async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
