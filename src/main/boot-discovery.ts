import type { SplashProgress } from '../shared/electron-api'
import { detectAgentCliAvailability } from './cli-availability'
import { listFolderOpenTargetAvailability, resolveFolderOpenLauncherHere } from './ipc/folder-open-ipc'

// The work the splash covers. Every leg here already existed and was already
// wired to IPC — this pass writes NO new probes, it just runs them during the
// dead time instead of after it.
//
// Why running them early is not just cosmetic: `detectAgentCliAvailability`
// caches per `(cli, command, useWsl)` for 60s, so the renderer's first
// `refreshCliAvailability` after hydration reads this pass's result instead of
// spawning a second login shell per registered CLI. A CLI carrying a custom
// command override keys differently and does re-probe — correct, since a
// different command has to actually be probed.
type BootDiscoveryLegId = 'cli' | 'editors' | 'updates'

type Leg = {
  id: BootDiscoveryLegId
  // Plain sentence, never a percentage. Copy from prototype variant A.
  status: string
}

// Declaration order is DISPLAY order, not run order: the legs run concurrently,
// and the status line names the first of these that has not resolved yet. The
// CLI leg spawns a login shell per registered CLI and dominates the wall clock,
// so in practice this reads "Finding your agents…" for most of the boot — which
// is the honest thing to say while that is what is happening.
const LEGS: readonly Leg[] = [
  { id: 'cli', status: 'Finding your agents…' },
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
    editors: deps.detectEditors ?? (async () => listFolderOpenTargetAvailability(resolveFolderOpenLauncherHere)),
    updates: deps.checkUpdates ?? (async () => undefined),
  }

  const unresolved = new Set<BootDiscoveryLegId>(LEGS.map((leg) => leg.id))

  const emit = (): void => {
    const inFlight = LEGS.find((leg) => unresolved.has(leg.id))
    onProgress({
      // Empty once everything has resolved: the plate holds the brand moment for
      // the few frames before the reveal rather than leaving a stale leg name up.
      status: inFlight?.status ?? '',
      progress: (LEGS.length - unresolved.size) / LEGS.length,
    })
  }

  emit()

  await Promise.all(
    LEGS.map(async (leg) => {
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
