import type { SplashProgress } from '../shared/electron-api'
import { detectAgentCliAvailability } from './cli-availability'
import { listFolderOpenTargetAvailability, resolveFolderOpenLauncherHere } from './ipc/folder-open-ipc'

// The work the splash covers. Every leg here already existed and was already
// wired to IPC — this pass writes NO new probes, it just runs them during the
// dead time instead of after it.
//
// Why running them early is not just cosmetic: `detectAgentCliAvailability`
// caches per `(cli, command, machine)`, so the renderer's first
// `refreshCliAvailability` after hydration reads this pass's result instead of
// probing every registered CLI a second time. A CLI carrying a custom
// command override keys differently and does re-probe — correct, since a
// different command has to actually be probed.
type BootDiscoveryLegId = 'cli' | 'workspaces' | 'editors' | 'updates'

type Leg = {
  id: BootDiscoveryLegId
  // Plain sentence, never a percentage. Copy from prototype variant A.
  status: string
}

// Declaration order is DISPLAY order, not run order: the legs run concurrently,
// and the status line names the first of these that has not resolved yet. The
// CLI leg asks a login shell for its PATH and runs every installed CLI's
// `--version`, and dominates the wall clock,
// so in practice this reads "Finding your agents…" for most of the boot — which
// is the honest thing to say while that is what is happening.
const LEGS: readonly Leg[] = [
  { id: 'cli', status: 'Finding your agents…' },
  // Only when the lifecycle hands one in (`prepareWorkspaces`). It is the one
  // leg the reveal waits for, and only for `BOOT_WORKSPACE_SYNC_BUDGET_MS`.
  { id: 'workspaces', status: 'Preparing your workspaces…' },
  { id: 'editors', status: 'Looking for editors…' },
  { id: 'updates', status: 'Checking for updates…' },
]

export type BootDiscoveryDeps = {
  detectClis?: () => Promise<unknown>
  detectEditors?: () => Promise<unknown>
  // Supplied by the lifecycle, which owns the update service and the
  // `app.isPackaged` guard. Defaults to a no-op so nothing here has to know
  // whether this build can update itself.
  checkUpdates?: () => Promise<unknown>
  /**
   * The workspace sync (the plugin home and the pass over every known
   * workspace), already bounded by the caller with `settleWithin`. Absent: the
   * leg is not shown at all.
   */
  prepareWorkspaces?: () => Promise<unknown>
  onProgress?: (update: SplashProgress) => void
  onLegError?: (leg: BootDiscoveryLegId, error: unknown) => void
}

export async function runBootDiscovery(deps: BootDiscoveryDeps = {}): Promise<void> {
  const onProgress = deps.onProgress ?? (() => {})
  const onLegError =
    deps.onLegError ??
    ((leg: BootDiscoveryLegId, error: unknown) => {
      console.error(`[BootDiscovery] ${leg} leg failed`, error)
    })

  const runners: Record<BootDiscoveryLegId, () => Promise<unknown>> = {
    cli: deps.detectClis ?? (() => detectAgentCliAvailability()),
    workspaces: deps.prepareWorkspaces ?? (async () => undefined),
    editors: deps.detectEditors ?? (async () => listFolderOpenTargetAvailability(resolveFolderOpenLauncherHere)),
    updates: deps.checkUpdates ?? (async () => undefined),
  }
  const legs = LEGS.filter((leg) => leg.id !== 'workspaces' || deps.prepareWorkspaces !== undefined)

  const unresolved = new Set<BootDiscoveryLegId>(legs.map((leg) => leg.id))

  const emit = (): void => {
    const inFlight = legs.find((leg) => unresolved.has(leg.id))
    onProgress({
      // Empty once everything has resolved: the plate holds the brand moment for
      // the few frames before the reveal rather than leaving a stale leg name up.
      status: inFlight?.status ?? '',
      progress: (legs.length - unresolved.size) / legs.length,
    })
  }

  emit()

  await Promise.all(
    legs.map(async (leg) => {
      try {
        await runners[leg.id]()
      } catch (error) {
        // A failed leg is reported, never swallowed — but it must not stall the
        // reveal. Nothing downstream consumes these results: the renderer
        // re-runs each probe as its own authoritative source, so a leg that
        // fails here costs a warmed cache, not correctness.
        onLegError(leg.id, error)
      } finally {
        unresolved.delete(leg.id)
        emit()
      }
    }),
  )
}

/**
 * How long the loading screen waits for the workspace sync (owner, 2026-09-28:
 * it belongs "when the user opens the application, at the loading screen").
 * The sync is a few small files per workspace, so on most machines it finishes
 * inside the time the renderer takes to paint anyway; the bound is for the
 * machine with a hundred workspaces on a slow disk, whose sync carries on after
 * the reveal exactly as it did before it moved here. Same order as the quit
 * removal's 5 s.
 */
export const BOOT_WORKSPACE_SYNC_BUDGET_MS = 4_000

type SettleTimers = {
  setTimer: (handler: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

const defaultSettleTimers: SettleTimers = {
  setTimer: (handler, ms) => setTimeout(handler, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Wait for `work` for at most `ms`, and say which came first. Never rejects: a
 * failed piece of work has settled, and waiting on it longer buys nothing. The
 * work itself is not cancelled — it keeps running after a timeout.
 */
export function settleWithin(
  work: Promise<unknown>,
  ms: number,
  timers: SettleTimers = defaultSettleTimers,
): Promise<'settled' | 'timed-out'> {
  return new Promise((resolve) => {
    const handle = timers.setTimer(() => resolve('timed-out'), ms)
    void work
      .catch(() => undefined)
      .then(() => {
        timers.clearTimer(handle)
        resolve('settled')
      })
  })
}
