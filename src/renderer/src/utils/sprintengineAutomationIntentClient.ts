/**
 * Renderer client for the main-owned Sprint Engine automation mode intent
 * (MC-1567). Store-free on purpose: `runStateSlice` imports the push side, so
 * this module must not import the workspace store (the subscription/hydration
 * side that needs the store lives in `sprintengineAutomationModeSync.ts`).
 *
 * Revision bookkeeping: main stamps every intent write with a monotonic
 * per-run revision. This module remembers the highest revision seen per
 * statePath (from pushes, reads, and applied broadcasts) so subscribers can
 * drop stale or echoed broadcasts instead of re-applying them — re-applying a
 * same-mode `user_set_mode` is not free (it would flip a paused run back to
 * running).
 */
import type { SprintEngineAutomationMode } from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'

const lastSeenRevisionByStatePath = new Map<string, number>()

export function noteSprintEngineAutomationRevision(statePath: string, revision: number): void {
  const current = lastSeenRevisionByStatePath.get(statePath) ?? 0
  if (revision > current) lastSeenRevisionByStatePath.set(statePath, revision)
}

export function isStaleSprintEngineAutomationRevision(statePath: string, revision: number): boolean {
  return revision <= (lastSeenRevisionByStatePath.get(statePath) ?? 0)
}

/** Test seam: forget all revision bookkeeping. */
export function resetSprintEngineAutomationRevisions(): void {
  lastSeenRevisionByStatePath.clear()
}

export type PushSprintEngineAutomationModeInput = {
  statePath: string
  mode: SprintEngineAutomationMode
  workspaceId: string
  workspaceName?: string
  reason?: string
  details?: string
  suppressManualAudit?: boolean
}

/**
 * Fire-and-forget write of the authoritative mode intent. The local store has
 * already transitioned optimistically; main persists, audits, bridges
 * cliWatchPolling, and broadcasts back (the broadcast is dropped as an echo by
 * the revision guard above). A failed push is surfaced as a warning diagnostic
 * — the renderer keeps functioning on its local state, which is the pre-MC-1567
 * behavior for every run.
 */
export function pushSprintEngineAutomationModeIntent(input: PushSprintEngineAutomationModeInput): void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setSprintEngineAutomationMode) return
  void api.setSprintEngineAutomationMode({
    statePath: input.statePath,
    mode: input.mode,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(input.suppressManualAudit ? { suppressManualAudit: true } : {}),
    workspaceId: input.workspaceId,
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
  })
    .then((result) => {
      if (result.ok) {
        noteSprintEngineAutomationRevision(input.statePath, result.record.revision)
        return
      }
      publishDiagnosticSync({
        level: 'warning',
        source: 'sprintengine',
        title: 'Automation mode not persisted',
        message: 'The automation mode changed locally but the authoritative store could not be written.',
        details: result.message,
        workspaceId: input.workspaceId,
        ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
      })
    })
    .catch((error) => {
      publishDiagnosticSync({
        level: 'warning',
        source: 'sprintengine',
        title: 'Automation mode not persisted',
        message: 'The automation mode changed locally but the authoritative store could not be written.',
        details: error instanceof Error ? error.message : String(error),
        workspaceId: input.workspaceId,
        ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
      })
    })
}
