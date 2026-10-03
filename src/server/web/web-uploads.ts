import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'

// Files a browser drops into a message (phase 9 spec, 4.1 #10; 14.14). A
// browser has no path for a dropped file, and the agent reads files by path
// on the server's machine, so the tab sends the bytes and the server answers
// where it put them: `<data dir>/web-uploads/<session>/<upload>/<name>`. That
// path is what goes into the message, as a dropped file's path does on the
// desktop.
//
// Owner sessions only, one file per request, 50 MB at most. Each upload has a
// directory of its own, so two files of one name never meet, and the name is
// the file's own made safe, so the agent reads a name the person recognises.
// Uploads are kept a week, then removed when the next one is saved.

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const UPLOADS_DIRNAME = 'web-uploads'

export type WebUploadAnswer =
  { ok: true; path: string; bytes: number } | { ok: false; status: 400 | 413 | 500; message: string }

export type WebUploads = {
  /** Save one request's body under a session's uploads. */
  save(input: { sessionId: string; name: string | null; request: IncomingMessage }): Promise<WebUploadAnswer>
  /** Remove a session's uploads, as its browser is removed. */
  forgetSession(sessionId: string): void
}

/** A dropped file's name, as a single path segment that is safe on every OS. */
export function safeUploadName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/u).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[<>:"|?*]/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 120)
  return cleaned || 'upload'
}

/** A session id as a directory name: its own characters, never a path. */
function sessionDir(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64) || 'session'
}

export function createWebUploads(options: { dataDir: string; now?: () => number }): WebUploads {
  const root = join(options.dataDir, UPLOADS_DIRNAME)
  const now = options.now ?? Date.now

  function prune(): void {
    let sessions: string[]
    try {
      sessions = readdirSync(root)
    } catch {
      return
    }
    for (const session of sessions) {
      const dir = join(root, session)
      let uploads: string[]
      try {
        uploads = readdirSync(dir)
      } catch {
        continue
      }
      for (const upload of uploads) {
        try {
          if (now() - statSync(join(dir, upload)).mtimeMs > KEEP_MS)
            rmSync(join(dir, upload), { recursive: true, force: true })
        } catch {
          // Gone already, or not ours to read.
        }
      }
    }
  }

  return {
    async save({ sessionId, name, request }) {
      const declared = Number(request.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES)
        return { ok: false, status: 413, message: 'That file is over 50 MB, too large to upload.' }
      prune()
      const dir = join(
        root,
        sessionDir(sessionId),
        `${new Date(now()).toISOString().slice(0, 10)}-${randomBytes(6).toString('hex')}`,
      )
      const path = join(dir, safeUploadName(name))
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      } catch {
        return { ok: false, status: 500, message: 'Studio could not make a place for the upload.' }
      }
      return new Promise<WebUploadAnswer>((resolve) => {
        let bytes = 0
        let settled = false
        const out = createWriteStream(path, { mode: 0o600, flags: 'wx' })
        const fail = (answer: Extract<WebUploadAnswer, { ok: false }>) => {
          if (settled) return
          settled = true
          request.unpipe(out)
          out.destroy()
          rmSync(dir, { recursive: true, force: true })
          // Read the rest so the answer can be sent on a socket still in order.
          request.resume()
          resolve(answer)
        }
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_UPLOAD_BYTES)
            fail({ ok: false, status: 413, message: 'That file is over 50 MB, too large to upload.' })
        })
        request.on('aborted', () => fail({ ok: false, status: 400, message: 'The upload was cut off.' }))
        request.on('error', () => fail({ ok: false, status: 400, message: 'The upload was cut off.' }))
        out.on('error', () => fail({ ok: false, status: 500, message: 'Studio could not save the upload.' }))
        out.on('finish', () => {
          if (settled) return
          settled = true
          resolve({ ok: true, path, bytes })
        })
        request.pipe(out)
      })
    },
    forgetSession(sessionId) {
      rmSync(join(root, sessionDir(sessionId)), { recursive: true, force: true })
    },
  }
}
