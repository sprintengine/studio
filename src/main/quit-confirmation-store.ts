/**
 * The "Ask before quitting while agents are working" switch, owned by main.
 *
 * Unlike the background-mode mirror, main writes this one itself: "Don't ask
 * again" is ticked in a native dialog, at a moment the renderer may be busy or
 * have no window at all. So main keeps the value, Settings reads and writes it
 * over IPC, and there is one writer per change rather than two copies to
 * reconcile.
 *
 * Absent, unreadable or malformed all read as ON: the question is the safe
 * default, and a store we cannot trust should cost the person one extra
 * question, never a quit that stopped their agents without one.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

const FILE_NAME = 'quit-confirmation.json'

export type QuitConfirmationStoreDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type QuitConfirmationStore = ReturnType<typeof createQuitConfirmationStore>

export function createQuitConfirmationStore(deps: QuitConfirmationStoreDeps) {
  let cached: boolean | null = null

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  return {
    /** Whether a quit asks while agents are working. Never throws. */
    isEnabled(): boolean {
      if (cached !== null) return cached
      try {
        const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
        cached =
          Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>).askBeforeQuit !== false
            : true
      } catch {
        cached = true
      }
      return cached
    },

    /** Idempotent: an unchanged value never rewrites the file. */
    set(enabled: boolean): void {
      const next = enabled === true
      if (this.isEnabled() === next) return
      cached = next
      const target = filePath()
      const tmp = `${target}.tmp-${process.pid}`
      try {
        writeFileSync(tmp, `${JSON.stringify({ askBeforeQuit: next })}\n`, 'utf8')
        renameSync(tmp, target)
      } catch (error) {
        try {
          unlinkSync(tmp)
        } catch {
          // The temp file may never have been created; nothing to clean up.
        }
        // In memory it still applies for this session.
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Quit confirmation setting not persisted',
          message:
            'The "Ask before quitting" setting could not be written to disk; it applies for this session but will not survive a restart.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
