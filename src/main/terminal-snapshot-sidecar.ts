import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentCli, AgentExecutionMode, TerminalKind } from '../shared/electron-api'

// Durable freeze-the-view: per-terminal snapshot sidecars under
// `<userData>/terminal-snapshots/<sessionId>.json`.
//
// The suspend path (terminal-runtime.suspendTerminal) already builds a faithful
// serialized screen (terminal-replay-snapshot.ts) so a paused agent repaints
// instead of showing black — but that snapshot lives only in the in-memory
// session map, so an app restart loses it and reopening the workspace finds a
// black terminal. These sidecars give that snapshot a disk lifecycle:
//
// - Written at suspend time (serialized snapshot) and at app quit (raw retained
//   pty stream — cheap byte dump; the snapshot is rebuilt lazily on rehydrate).
// - Read on the first terminal-status lookup after restart to materialize a
//   suspended placeholder session, so the existing pause/replay/resume flow
//   fires with zero renderer changes.
// - Removed by disposeTerminal (dispose means gone — never rehydrated) and by
//   the TTL sweep. App-quit teardown deliberately does NOT dispose through
//   disposeTerminal, so quit never erases what it just saved.
//
// Content is whatever was painted on screen, stored in plaintext under
// userData — the same trust boundary as the rest of the app's persisted state
// (accepted in the backlog item).

export const TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME = 'terminal-snapshots'

// Sidecars a month old are painted history nobody has come back for; reclaim
// the disk. Resume/dispose delete them much earlier in the common case.
export const TERMINAL_SNAPSHOT_SIDECAR_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type TerminalSnapshotSidecar = {
  version: 1
  sessionId: string
  savedAt: number
  cols: number
  rows: number
  kind: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  // The CLI's own resume id (may differ from sessionId for CLIs that mint their
  // own). Carried onto the placeholder so resume targets the right conversation
  // even if the renderer's payload lacks it.
  cliSessionId?: string
  cwd?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  // Exactly one of these carries the painted content: `snapshot` is a
  // headless-xterm serialized screen (replays faithfully, incl. alt-screen
  // TUIs); `rawReplay` is the retained pty byte stream captured on the quit
  // path, rendered to a snapshot lazily at rehydrate time.
  snapshot?: string
  rawReplay?: string
}

export type TerminalSnapshotSidecarStore = {
  read(sessionId: string): TerminalSnapshotSidecar | null
  write(sidecar: TerminalSnapshotSidecar): void
  remove(sessionId: string): void
  // Delete sidecars whose write time is older than the TTL; returns the removed
  // file names. Piggybacked on the runtime's stale-terminal sweep.
  sweepExpired(now?: number): string[]
}

// Session ids are minted with crypto.randomUUID, but they arrive over IPC — a
// sidecar file name must never be attacker-influenced path material.
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && sessionId !== '.' && sessionId !== '..'
}

export function createTerminalSnapshotSidecarStore(options: {
  resolveUserDataDir: () => string
  ttlMs?: number
  logDiagnostic?: (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => void
}): TerminalSnapshotSidecarStore {
  const ttlMs = options.ttlMs ?? TERMINAL_SNAPSHOT_SIDECAR_TTL_MS
  const sidecarDir = () => join(options.resolveUserDataDir(), TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME)
  const sidecarPath = (sessionId: string) => join(sidecarDir(), `${sessionId}.json`)

  const warn = (title: string, error: unknown): void => {
    options.logDiagnostic?.({
      level: 'warning',
      title,
      message: 'Terminal snapshot sidecar operation failed.',
      details: error instanceof Error ? error.message : String(error),
    })
  }

  return {
    read(sessionId: string): TerminalSnapshotSidecar | null {
      if (!isSafeSessionId(sessionId)) return null
      let raw: string
      try {
        raw = readFileSync(sidecarPath(sessionId), 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') warn('Terminal snapshot sidecar read failed', error)
        return null
      }
      try {
        const parsed = JSON.parse(raw) as Partial<TerminalSnapshotSidecar>
        if (
          parsed.version !== 1
          || parsed.sessionId !== sessionId
          || typeof parsed.savedAt !== 'number'
          || typeof parsed.cols !== 'number'
          || typeof parsed.rows !== 'number'
          || (typeof parsed.snapshot !== 'string' && typeof parsed.rawReplay !== 'string')
        ) {
          throw new Error('malformed_terminal_snapshot_sidecar')
        }
        return parsed as TerminalSnapshotSidecar
      } catch (error) {
        warn('Terminal snapshot sidecar parse failed', error)
        return null
      }
    },
    write(sidecar: TerminalSnapshotSidecar): void {
      if (!isSafeSessionId(sidecar.sessionId)) return
      if (!sidecar.snapshot && !sidecar.rawReplay) return
      try {
        const path = sidecarPath(sidecar.sessionId)
        const tmp = `${path}.tmp`
        mkdirSync(sidecarDir(), { recursive: true })
        writeFileSync(tmp, JSON.stringify(sidecar), { mode: 0o600 })
        renameSync(tmp, path)
      } catch (error) {
        warn('Terminal snapshot sidecar write failed', error)
      }
    },
    remove(sessionId: string): void {
      if (!isSafeSessionId(sessionId)) return
      try {
        rmSync(sidecarPath(sessionId), { force: true })
      } catch (error) {
        warn('Terminal snapshot sidecar remove failed', error)
      }
    },
    sweepExpired(now = Date.now()): string[] {
      let entries: string[]
      try {
        entries = readdirSync(sidecarDir())
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') warn('Terminal snapshot sidecar sweep failed', error)
        return []
      }
      const removed: string[] = []
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue
        const path = join(sidecarDir(), entry)
        try {
          const age = now - statSync(path).mtimeMs
          if (age > ttlMs) {
            rmSync(path, { force: true })
            removed.push(entry)
          }
        } catch {
          // Raced with a concurrent remove/rewrite; the next sweep settles it.
        }
      }
      return removed
    },
  }
}
