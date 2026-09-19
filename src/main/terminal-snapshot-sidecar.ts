import { readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import type { ObservedCheckout } from '../shared/observed-checkout'
import { join } from 'path'
import type {
  AgentCli,
  AgentExecutionMode,
  SessionContextUsage,
  SessionFileChange,
  SessionPrompt,
  TerminalKind,
} from '../shared/electron-api'

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
  // When the agent's last turn ended, so rehydration idles the placeholder
  // from the finish rather than from `savedAt` (one quit stamps every sidecar).
  lastTurnEndedAt?: number
  // The checkout the session's hooks last observed, so a parked
  // agent keeps saying where it is across suspend / resume / an app restart.
  // Read back through parseObservedCheckout — the file is untrusted input.
  observedCheckout?: ObservedCheckout
  // What the parked session edited, newest-edited first, so the ledger a person
  // saw before quitting is still there when the app comes back. Bounded by
  // MAX_SESSION_FILE_CHANGES on the way in; read back through
  // parseSessionFileChanges, since this file is untrusted input too.
  fileChanges?: SessionFileChange[]
  // What the person typed into this chat, oldest first, from the CLI's
  // `UserPromptSubmit` hook. The conversation peek's only source for a runtime
  // whose transcript this app cannot read (Codex, Grok, Kimi Code), and without
  // it a parked one of those comes back claiming to have no messages. Bounded
  // by MAX_LIVE_PEEK_PROMPTS on the way in; read back through
  // parseSessionPrompts, untrusted like everything else here.
  //
  // This is a person's verbatim typing, in plaintext under userData — which is
  // the same trust boundary the painted screen beside it already sits on, and
  // that screen is a picture of these very words. It leaves with the sidecar on
  // dispose and at the TTL sweep.
  prompts?: SessionPrompt[]
  // How full the parked session's context window was, so a chat frozen across
  // an app restart still says so. Read back through parseSessionContextUsage —
  // untrusted input like the rest of this file.
  contextUsage?: SessionContextUsage
  // Exactly one of these carries the painted content: `snapshot` is a
  // headless-xterm serialized screen (replays faithfully, incl. alt-screen
  // TUIs); `rawReplay` is the retained pty byte stream captured on the quit
  // path, rendered to a snapshot lazily at rehydrate time.
  snapshot?: string
  rawReplay?: string
}

export type TerminalSnapshotSidecarStore = {
  read(sessionId: string): TerminalSnapshotSidecar | null
  // Queue the write. It lands on disk off the main thread — a sidecar is up
  // to a few megabytes and used to be a synchronous write on the suspend,
  // self-exit and quit paths — but it is readable through `read` at once,
  // and `flush` awaits every queued write for the quit path.
  write(sidecar: TerminalSnapshotSidecar): void
  remove(sessionId: string): void
  // Delete sidecars whose write time is older than the TTL; returns the removed
  // file names. Piggybacked on the runtime's stale-terminal sweep.
  sweepExpired(now?: number): string[]
  // Every queued write has landed (or failed and been reported).
  flush(): Promise<void>
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

  // What is queued but not yet on disk, so a read between the two sees the
  // newest sidecar; and one write chain per session, so two writes for one
  // session land in order and a remove runs after the write it follows.
  const pending = new Map<string, TerminalSnapshotSidecar>()
  const chains = new Map<string, Promise<void>>()

  function chain(sessionId: string, task: () => Promise<void>, title: string): void {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(task).catch((error) => warn(title, error))
    chains.set(sessionId, next)
    void next.then(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
  }

  return {
    read(sessionId: string): TerminalSnapshotSidecar | null {
      if (!isSafeSessionId(sessionId)) return null
      const queued = pending.get(sessionId)
      if (queued) return queued
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
          parsed.version !== 1 ||
          parsed.sessionId !== sessionId ||
          typeof parsed.savedAt !== 'number' ||
          typeof parsed.cols !== 'number' ||
          typeof parsed.rows !== 'number' ||
          (typeof parsed.snapshot !== 'string' && typeof parsed.rawReplay !== 'string')
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
      const { sessionId } = sidecar
      pending.set(sessionId, sidecar)
      chain(
        sessionId,
        async () => {
          // Superseded by a later write, or removed, before this ran.
          if (pending.get(sessionId) !== sidecar) return
          const path = sidecarPath(sessionId)
          const tmp = `${path}.tmp`
          await mkdir(sidecarDir(), { recursive: true })
          await writeFile(tmp, JSON.stringify(sidecar), { mode: 0o600 })
          await rename(tmp, path)
          if (pending.get(sessionId) === sidecar) pending.delete(sessionId)
        },
        'Terminal snapshot sidecar write failed',
      )
    },
    remove(sessionId: string): void {
      if (!isSafeSessionId(sessionId)) return
      pending.delete(sessionId)
      // Gone at once for a reader, and gone again after any write in flight,
      // so a queued sidecar cannot resurrect what dispose just removed.
      try {
        rmSync(sidecarPath(sessionId), { force: true })
      } catch (error) {
        warn('Terminal snapshot sidecar remove failed', error)
      }
      if (chains.has(sessionId)) {
        chain(sessionId, () => rm(sidecarPath(sessionId), { force: true }), 'Terminal snapshot sidecar remove failed')
      }
    },
    async flush(): Promise<void> {
      await Promise.all([...chains.values()])
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
