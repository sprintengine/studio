import { mkdirSync, readdirSync, statSync, unlinkSync, writeSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

// The Studio server's own log: what it writes to stdout and stderr, piped by
// the shell, one timestamped line at a time, into `<logs>/server-YYYY-MM-DD.log`.
// A day's file stops at 10 MB and the next part begins (`…-2026-10-02.1.log`);
// fourteen days are kept. The last 200 lines stay in memory for the banner a
// failed server shows and for Diagnostics, so neither has to read the disk.
//
// Writes are synchronous and small: the server says little, and a line that
// waits in a buffer is the line lost when the shell is killed.

export type ServerLogStream = 'out' | 'err'

export type ServerLog = {
  /** A chunk as the pipe delivered it: split into lines, the last partial one held for the next chunk. */
  write(stream: ServerLogStream, chunk: string | Buffer): void
  /** A line the shell itself says about the server (a fork, an exit, a kill). */
  note(line: string): void
  /** The last lines, oldest first. */
  tail(): string[]
  /** The file being written now. */
  currentPath(): string | null
  close(): void
}

export type ServerLogOptions = {
  /** Read when the first line is written: Electron's logs path is settled only once the app is ready. */
  logsDir: string | (() => string)
  now?: () => Date
  maxFileBytes?: number
  keepDays?: number
  tailLines?: number
  /** Every line as it is appended (a dev build echoes them to its terminal). */
  onLine?: (line: string) => void
}

const MAX_FILE_BYTES = 10 * 1024 * 1024
const KEEP_DAYS = 14
const TAIL_LINES = 200
const FILE_PATTERN = /^server-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/

export function createServerLog(options: ServerLogOptions): ServerLog {
  const now = options.now ?? (() => new Date())
  const logsDir = (): string => (typeof options.logsDir === 'function' ? options.logsDir() : options.logsDir)
  const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES
  const keepDays = options.keepDays ?? KEEP_DAYS
  const tailLines = options.tailLines ?? TAIL_LINES
  const tail: string[] = []
  const partial: Record<ServerLogStream, string> = { out: '', err: '' }
  let fd: number | null = null
  let path: string | null = null
  let day: string | null = null
  let part = 0
  let size = 0
  let failed = false

  function close(): void {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Closing what failed to write: nothing more to do.
      }
    }
    fd = null
  }

  function open(today: string): void {
    close()
    try {
      mkdirSync(logsDir(), { recursive: true })
      // A part already written today (the app restarted) is appended to while it has room.
      for (;;) {
        const candidate = join(logsDir(), `server-${today}${part > 0 ? `.${part}` : ''}.log`)
        let existing = 0
        try {
          existing = statSync(candidate).size
        } catch {
          // Not there yet.
        }
        if (existing < maxBytes) {
          fd = openSync(candidate, 'a', 0o600)
          path = candidate
          size = existing
          break
        }
        part++
      }
      if (day !== today) prune(today)
      day = today
      failed = false
    } catch {
      // A logs directory that cannot be written: the tail still keeps the
      // last lines, and the next day tries again.
      failed = true
      fd = null
    }
  }

  function prune(today: string): void {
    const cutoff = Date.parse(`${today}T00:00:00Z`) - keepDays * 24 * 60 * 60 * 1000
    let entries: string[]
    try {
      entries = readdirSync(logsDir())
    } catch {
      return
    }
    for (const entry of entries) {
      const match = FILE_PATTERN.exec(entry)
      if (!match) continue
      if (Date.parse(`${match[1]}T00:00:00Z`) < cutoff) {
        try {
          unlinkSync(join(logsDir(), entry))
        } catch {
          // Someone else's, or gone already.
        }
      }
    }
  }

  function append(line: string): void {
    options.onLine?.(line)
    tail.push(line)
    if (tail.length > tailLines) tail.splice(0, tail.length - tailLines)
    const stamp = now()
    const today = stamp.toISOString().slice(0, 10)
    if (today !== day) {
      part = 0
      open(today)
    } else if (fd === null && !failed) open(today)
    if (fd === null) return
    const text = `${stamp.toISOString()} ${line}\n`
    const bytes = Buffer.byteLength(text)
    if (size + bytes > maxBytes && size > 0) {
      part++
      open(today)
      if (fd === null) return
    }
    try {
      writeSync(fd, text)
      size += bytes
    } catch {
      failed = true
      close()
    }
  }

  return {
    write(stream, chunk) {
      const text = partial[stream] + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      const lines = text.split(/\r?\n/)
      partial[stream] = lines.pop() ?? ''
      for (const line of lines) if (line.length > 0) append(stream === 'err' ? `[err] ${line}` : line)
    },
    note(line) {
      append(`[shell] ${line}`)
    },
    tail: () => [...tail],
    currentPath: () => path,
    close() {
      for (const stream of ['out', 'err'] as const) {
        if (partial[stream]) append(stream === 'err' ? `[err] ${partial[stream]}` : partial[stream])
        partial[stream] = ''
      }
      close()
    },
  }
}
