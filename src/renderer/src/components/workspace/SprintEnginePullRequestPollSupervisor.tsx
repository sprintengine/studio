import { useEffect, useRef } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../types/workspace'
import { backoffDelayMs, type ExponentialBackoffOptions } from '../../utils/exponentialBackoff'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import { registerTimer, type TimerHandle } from '../../utils/diagnostics/timerRegistry'

// A completed sprint opens a pull request whose merge happens later, on GitHub,
// outside the app. The sidebar glyph only flips to merged-purple once the run's
// `vcs.pullRequestState` reads `merged`, and that field only updates when the
// `vcs pr-status` GitHub probe runs. Nothing probes a dormant run in the
// background, so the glyph stays green ("Ready for review") until the user
// re-opens the board. This window-level supervisor re-probes every sprint
// workspace with an open PR on an exponential backoff — surface-independent, so
// the glyph self-heals without the board being on-screen.
//
// Backoff: 1 → 2 → 4 → 8 → 16 → 32 min (six probes over ~63 min), then the
// poller halts for that run. It re-arms — restarting from 1 min — when the
// workspace is opened again (becomes the active workspace). This deliberately
// re-introduces the periodic `gh` calls that on-demand refresh removed, but
// bounded: worst case six probes per run per attention cycle, then silence.
export const PR_MERGE_POLL_BACKOFF: ExponentialBackoffOptions = {
  baseMs: 60_000,
  factor: 2,
  maxMs: 32 * 60_000,
  stopAtMax: true,
}

const PR_POLL_TIMER_LABEL = 'SprintEngine PR merge poll'

type PrState = 'open' | 'merged' | 'closed' | null

// A run whose PR is worth re-probing: it has a branch/PR (vcs) and the PR is not
// already in a terminal state. `open` is the live case; `null` with a URL is a
// PR whose state is not yet known (just created). Merged/closed are terminal —
// the glyph is already correct, nothing left to watch.
export function isPullRequestWatchable(input: {
  hasVcs: boolean
  prState: PrState
  hasPrUrl: boolean
}): boolean {
  const { hasVcs, prState, hasPrUrl } = input
  if (!hasVcs) return false
  if (prState === 'merged' || prState === 'closed') return false
  return prState === 'open' || (prState === null && hasPrUrl)
}

export type PullRequestPollTarget = {
  workspaceId: string
  statePath: string
}

// Enumerate the sprint workspaces in this window whose PR is still watchable.
// Pure over the store snapshot so the selection is unit-tested without React.
export function collectWatchablePullRequestTargets(
  workspaces: readonly Workspace[],
  workspaceIds: ReadonlySet<string>,
): PullRequestPollTarget[] {
  const targets: PullRequestPollTarget[] = []
  for (const workspace of workspaces) {
    if (!workspaceIds.has(workspace.id)) continue
    if (workspace.mode !== 'sprintengine' && !workspace.sprintEngineContext) continue
    const statePath = workspace.sprintEngineContext?.statePath
    if (!statePath) continue
    const vcs = workspace.sprintEngineState?.vcs
    if (
      isPullRequestWatchable({
        hasVcs: !!vcs,
        prState: vcs?.pullRequestState ?? null,
        hasPrUrl: !!vcs?.pullRequestUrl,
      })
    ) {
      targets.push({ workspaceId: workspace.id, statePath })
    }
  }
  return targets
}

type PollerEntry = {
  attempt: number
  timeoutId: number | null
  exhausted: boolean
}

export type PullRequestPollController = {
  // Reconcile the live set of watchable runs against the running pollers.
  // Newly-watchable runs arm at the base delay; runs that drop out (merged,
  // closed, or unloaded) disarm. An exhausted poller re-arms only when its
  // workspace has just become the active one — the "opened again" trigger.
  sync(targets: readonly PullRequestPollTarget[], activeWorkspaceId: string | null): void
  dispose(): void
}

export type PullRequestPollControllerDeps = {
  // Probe GitHub for one run's merge state and pull the result into the store.
  probe: (target: PullRequestPollTarget) => Promise<void>
  backoff: ExponentialBackoffOptions
  setTimeout: (handler: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  // Called whenever the number of runs still inside the backoff lifecycle (armed
  // or mid-probe, i.e. not exhausted/removed) changes, so the caller can register
  // and unregister a single diagnostics timer for the quiescence signal.
  onActiveCountChange?: (activeCount: number) => void
}

// Owns the per-workspace backoff timers. A self-scheduling setTimeout chain (not
// a fixed setInterval) because each step's delay grows. State lives here, not in
// React, so switching the active workspace never resets in-flight backoff.
// setTimeout/clearTimeout are injected so the schedule is driven synchronously in
// tests.
export function createPullRequestPollController(
  deps: PullRequestPollControllerDeps,
): PullRequestPollController {
  const entries = new Map<string, PollerEntry>()
  let lastActiveId: string | null = null

  const activeCount = (): number => {
    let count = 0
    for (const entry of entries.values()) if (!entry.exhausted) count += 1
    return count
  }
  const notify = (): void => deps.onActiveCountChange?.(activeCount())

  const schedule = (workspaceId: string, target: PullRequestPollTarget): void => {
    const entry = entries.get(workspaceId)
    if (!entry) return
    const delay = backoffDelayMs(entry.attempt, deps.backoff)
    if (delay === null) {
      entry.exhausted = true
      entry.timeoutId = null
      return
    }
    entry.timeoutId = deps.setTimeout(() => {
      const fired = entries.get(workspaceId)
      if (!fired) return
      fired.timeoutId = null
      void Promise.resolve(deps.probe(target)).finally(() => {
        const current = entries.get(workspaceId)
        // Re-arm/disarm during the in-flight probe wins — if the entry was
        // removed or replaced, drop this continuation.
        if (!current || current !== fired) return
        current.attempt += 1
        schedule(workspaceId, target)
        notify()
      })
    }, delay)
  }

  const arm = (workspaceId: string, target: PullRequestPollTarget): void => {
    const existing = entries.get(workspaceId)
    if (existing?.timeoutId != null) deps.clearTimeout(existing.timeoutId)
    const entry: PollerEntry = { attempt: 0, timeoutId: null, exhausted: false }
    entries.set(workspaceId, entry)
    schedule(workspaceId, target)
  }

  const disarm = (workspaceId: string): void => {
    const entry = entries.get(workspaceId)
    if (entry?.timeoutId != null) deps.clearTimeout(entry.timeoutId)
    entries.delete(workspaceId)
  }

  return {
    sync(targets, activeWorkspaceId) {
      const targetById = new Map(targets.map((target) => [target.workspaceId, target]))
      // Disarm runs that are no longer watchable (merged/closed/unloaded).
      for (const id of [...entries.keys()]) {
        if (!targetById.has(id)) disarm(id)
      }
      for (const target of targets) {
        const entry = entries.get(target.workspaceId)
        if (!entry) {
          arm(target.workspaceId, target)
          continue
        }
        // "Opened again": the workspace just transitioned to active. Re-arm an
        // exhausted poller so a run whose PR is still open gets another backoff
        // cycle when the user returns to it.
        const justActivated =
          activeWorkspaceId === target.workspaceId && activeWorkspaceId !== lastActiveId
        if (entry.exhausted && justActivated) arm(target.workspaceId, target)
      }
      lastActiveId = activeWorkspaceId
      notify()
    },
    dispose() {
      for (const id of [...entries.keys()]) disarm(id)
      lastActiveId = null
      notify()
    },
  }
}

type Props = {
  activeWorkspaceId: string | null
  workspaceIds: string[]
}

export default function SprintEnginePullRequestPollSupervisor({
  activeWorkspaceId,
  workspaceIds,
}: Props) {
  // Read prop values reactively without re-running the mount effect (which would
  // recreate the controller and wipe in-flight backoff state).
  const activeIdRef = useRef(activeWorkspaceId)
  activeIdRef.current = activeWorkspaceId
  const workspaceIdsRef = useRef(workspaceIds)
  workspaceIdsRef.current = workspaceIds
  const workspaceKey = workspaceIds.join('\n')
  const evaluateRef = useRef<() => void>(() => {})

  // Mount-only: build the controller and subscribe to the store. The controller
  // outlives active-workspace and workspace-set changes, so backoff progress is
  // preserved across them.
  useEffect(() => {
    let disposed = false
    let timer: TimerHandle | null = null
    const tokens = new Map<string, string>()

    const controller = createPullRequestPollController({
      backoff: PR_MERGE_POLL_BACKOFF,
      setTimeout: (handler, ms) => window.setTimeout(handler, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      probe: async (target) => {
        if (disposed) return
        try {
          const result = await window.api.refreshSprintEnginePullRequestStatus(target.statePath)
          if (disposed || !result.ok) return
          const workspace = useWorkspaceStore
            .getState()
            .workspaces.find((candidate) => candidate.id === target.workspaceId)
          if (!workspace) return
          // Pull the freshly-probed merge state into the store so the sidebar
          // glyph, header chip, and summary all reflect it.
          await refreshSprintEngineWorkspaceProjection({
            workspace,
            tokens,
            cause: 'supervisor',
            force: true,
          })
        } catch {
          // Best-effort: a transient gh/git failure just retries on the next step.
        }
      },
      onActiveCountChange: (count) => {
        if (disposed) return
        // One diagnostics timer stands for the whole supervisor: registered while
        // any run is still inside its backoff lifecycle, unregistered the moment
        // the last one exhausts or disarms — the verifiable quiescence signal.
        if (count > 0 && !timer) {
          timer = registerTimer(PR_POLL_TIMER_LABEL, PR_MERGE_POLL_BACKOFF.baseMs)
        } else if (count === 0 && timer) {
          timer.unregister()
          timer = null
        }
      },
    })

    const evaluate = (): void => {
      if (disposed) return
      const { workspaces } = useWorkspaceStore.getState()
      const targets = collectWatchablePullRequestTargets(
        workspaces,
        new Set(workspaceIdsRef.current),
      )
      controller.sync(targets, activeIdRef.current)
    }
    evaluateRef.current = evaluate

    evaluate()
    const unsubscribe = useWorkspaceStore.subscribe(evaluate)

    return () => {
      disposed = true
      unsubscribe()
      controller.dispose()
      evaluateRef.current = () => {}
      if (timer) {
        timer.unregister()
        timer = null
      }
    }
  }, [])

  // Re-evaluate when the active workspace or the window's workspace set changes.
  // Neither is a store transition the subscription above sees, so drive it here;
  // the controller re-arms an exhausted poller for a workspace just opened.
  useEffect(() => {
    evaluateRef.current()
  }, [activeWorkspaceId, workspaceKey])

  return null
}
