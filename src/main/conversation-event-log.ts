import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'

import type { ConversationEvent } from '../shared/conversation-runtime'

/**
 * The append side of a chat's JSONL transcript.
 *
 * A streaming chat produces a `content_delta` or `reasoning_delta` per token,
 * thirty to a hundred a second. Writing each one as its own open-append-close
 * made every token a filesystem round trip — a virus-scanner pass on Windows, a
 * 9P hop on a WSL root — and, because the write was awaited before listeners
 * ran, it made the chat on screen wait for the disk too. So:
 *
 *  - The caller emits to listeners FIRST and hands the event here afterwards.
 *  - Consecutive deltas of one kind in one turn are merged into a single record
 *    in memory and written when the run ends: at the next non-delta event (a
 *    tool call, an approval, the end of the turn) or after
 *    {@link DEFAULT_DELTA_FLUSH_MS}, whichever is first. A crash therefore loses
 *    at most the text streamed since the last flush of the message in flight;
 *    everything before it, and every boundary event, is already on disk.
 *  - One append stream stays open per transcript file and every write goes
 *    through it in order, so on-disk order is emission order.
 *
 * A merged record keeps the first delta's envelope and carries `parts` — each
 * original delta's id, timestamp and length — so {@link expandCoalescedDeltas}
 * can hand a reader the exact events that were emitted live. That matters: the
 * chat view dedupes a replayed transcript against live pushes by event id, and
 * a chat mounted mid-stream has already seen some of those ids.
 */

/** How long a run of deltas may sit in memory before it is written anyway. */
export const DEFAULT_DELTA_FLUSH_MS = 300

/** `[event id, createdAt, text length]` for one delta folded into a merged record. */
type DeltaPart = [string, number, number]

type PersistedEvent = ConversationEvent & { parts?: DeltaPart[] }

type DeltaRun = { event: ConversationEvent; text: string; parts: DeltaPart[] }

export type AppendStream = {
  write(chunk: string): Promise<void>
  close(): Promise<void>
}

export type ConversationEventLogOptions = {
  flushDelayMs?: number
  openStream?: (filePath: string) => Promise<AppendStream>
  onError?: (filePath: string, error: unknown) => void
}

type FileLog = {
  run: DeltaRun | null
  queued: string[]
  timer: NodeJS.Timeout | null
  stream: Promise<AppendStream> | null
  // Every write and close for this file, in order.
  tail: Promise<void>
}

export class ConversationEventLog {
  private readonly files = new Map<string, FileLog>()
  // Closes still in flight, so a log reopened for the same file queues its
  // first write behind the old stream's last one.
  private readonly closing = new Map<string, Promise<void>>()
  private readonly flushDelayMs: number
  private readonly openStream: (filePath: string) => Promise<AppendStream>
  private readonly onError: (filePath: string, error: unknown) => void

  constructor(options: ConversationEventLogOptions = {}) {
    this.flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_DELTA_FLUSH_MS)
    this.openStream = options.openStream ?? openAppendStream
    this.onError = options.onError ?? (() => undefined)
  }

  /**
   * Record `event`. A delta is buffered and the returned promise settles at
   * once; anything else is a boundary, written together with the run before it,
   * and the promise settles once both are on disk. Never rejects: a transcript
   * that cannot be written must not take the live chat down with it.
   */
  append(filePath: string, event: ConversationEvent): Promise<void> {
    const log = this.fileLog(filePath)
    if (isDelta(event)) {
      const text = deltaText(event)
      if (log.run && text !== null && canExtend(log.run, event)) {
        log.run.text += text
        log.run.parts.push([event.id, event.createdAt, text.length])
      } else {
        this.endRun(log)
        if (text === null) log.queued.push(serialize(event))
        else log.run = { event, text, parts: [[event.id, event.createdAt, text.length]] }
      }
      if (!log.timer) {
        log.timer = setTimeout(() => {
          log.timer = null
          void this.write(filePath, log)
        }, this.flushDelayMs)
        log.timer.unref?.()
      }
      return Promise.resolve()
    }
    this.endRun(log)
    log.queued.push(serialize(event))
    return this.write(filePath, log)
  }

  /**
   * Write whatever is buffered — for one file, or for all of them — and wait
   * for it to be on disk. A file whose log is being closed (the idle sweep, a
   * session stopping) is already detached from `files`, but its last chunk may
   * still be in flight: a reader that flushes before reading waits for that
   * close too, or it could read the transcript without its tail.
   */
  async flush(filePath?: string): Promise<void> {
    const targets =
      filePath === undefined ? new Set([...this.files.keys(), ...this.closing.keys()]) : new Set([filePath])
    await Promise.all(
      Array.from(targets, (path) => {
        const log = this.files.get(path)
        // A log reopened during a close queues behind it (its tail starts from
        // the close), so its own write covers both.
        if (log) return this.write(path, log)
        return this.closing.get(path) ?? Promise.resolve()
      }),
    )
  }

  /** Flush and close one file's stream. A later append simply opens a new one. */
  async close(filePath: string): Promise<void> {
    const log = this.files.get(filePath)
    // Already closing: the caller still expects it closed when this settles.
    if (!log) return this.closing.get(filePath)
    // Detached first, so an append that lands while this close is in flight
    // starts a new log (queued behind nothing of ours) instead of adding to one
    // that is about to be closed and forgotten.
    this.files.delete(filePath)
    const done = this.write(filePath, log).then(async () => {
      const stream = log.stream
      log.stream = null
      if (!stream) return
      try {
        await (await stream).close()
      } catch (error) {
        this.onError(filePath, error)
      }
    })
    this.closing.set(filePath, done)
    await done
    if (this.closing.get(filePath) === done) this.closing.delete(filePath)
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.files.keys()).map((path) => this.close(path)))
  }

  private fileLog(filePath: string): FileLog {
    let log = this.files.get(filePath)
    if (!log) {
      const tail = this.closing.get(filePath) ?? Promise.resolve()
      log = { run: null, queued: [], timer: null, stream: null, tail }
      this.files.set(filePath, log)
    }
    return log
  }

  private endRun(log: FileLog): void {
    if (!log.run) return
    log.queued.push(serializeRun(log.run))
    log.run = null
  }

  private write(filePath: string, log: FileLog): Promise<void> {
    if (log.timer) {
      clearTimeout(log.timer)
      log.timer = null
    }
    // A timer flush with a run still open writes the run so far; the next delta
    // starts a fresh record rather than rewriting this one.
    this.endRun(log)
    if (log.queued.length === 0) return log.tail
    const chunk = log.queued.join('')
    log.queued = []
    log.tail = log.tail.then(async () => {
      try {
        if (!log.stream) log.stream = this.openStream(filePath)
        await (await log.stream).write(chunk)
      } catch (error) {
        // Drop the broken stream so the next write reopens rather than failing
        // forever on a handle that is gone.
        log.stream = null
        this.onError(filePath, error)
      }
    })
    return log.tail
  }
}

/**
 * The events a reader should see for one persisted record: a merged delta
 * record back into the deltas it was built from, anything else as it is.
 */
export function expandCoalescedDeltas(record: ConversationEvent): ConversationEvent[] {
  const { parts, ...event } = record as PersistedEvent
  if (!Array.isArray(parts) || parts.length === 0) return [record]
  const text = deltaText(event)
  if (text === null || !parts.every(isDeltaPart)) return [event]
  if (parts.reduce((sum, part) => sum + part[2], 0) !== text.length) return [event]
  const expanded: ConversationEvent[] = []
  let offset = 0
  for (const [id, createdAt, length] of parts) {
    expanded.push({
      ...event,
      id,
      createdAt,
      payload: { ...event.payload, text: text.slice(offset, offset + length) },
    })
    offset += length
  }
  return expanded
}

function isDelta(event: ConversationEvent): boolean {
  return event.type === 'content_delta' || event.type === 'reasoning_delta'
}

/** The delta's text when its payload is exactly `{ turnId?, text }`, else null (written as-is). */
function deltaText(event: ConversationEvent): string | null {
  const payload = event.payload
  if (!payload || typeof payload.text !== 'string') return null
  for (const key of Object.keys(payload)) if (key !== 'text' && key !== 'turnId') return null
  return payload.text
}

function canExtend(run: DeltaRun, event: ConversationEvent): boolean {
  const head = run.event
  return (
    head.type === event.type &&
    head.sessionId === event.sessionId &&
    head.workspaceId === event.workspaceId &&
    head.agentId === event.agentId &&
    head.providerId === event.providerId &&
    head.modelId === event.modelId &&
    head.payload?.turnId === event.payload?.turnId
  )
}

function serialize(event: ConversationEvent): string {
  return `${JSON.stringify(event)}\n`
}

function serializeRun(run: DeltaRun): string {
  if (run.parts.length === 1) return serialize(run.event)
  const merged: PersistedEvent = {
    ...run.event,
    payload: { ...run.event.payload, text: run.text },
    parts: run.parts,
  }
  return serialize(merged)
}

function isDeltaPart(value: unknown): value is DeltaPart {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number' &&
    Number.isInteger(value[2]) &&
    value[2] >= 0
  )
}

async function openAppendStream(filePath: string): Promise<AppendStream> {
  await mkdir(dirname(filePath), { recursive: true })
  const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
  let failure: Error | null = null
  stream.on('error', (error) => {
    failure = error
  })
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        if (failure) {
          reject(failure)
          return
        }
        stream.write(chunk, (error) => (error ? reject(error) : resolve()))
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (stream.destroyed || failure) {
          resolve()
          return
        }
        stream.end(() => resolve())
      }),
  }
}
