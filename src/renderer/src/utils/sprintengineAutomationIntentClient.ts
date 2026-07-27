/**
 * Renderer client for the main-owned Sprint Engine automation mode intent
 * (MC-1567). Store-free on purpose: `runStateSlice` imports the push side, so
 * this module must not import the workspace store (the subscription/hydration
 * side that needs the store lives in `sprintengineAutomationModeSync.ts`).
 *
 * Echo/ordering model (the subtle part): main broadcasts from inside its
 * serialized write task, so the echo of a local push reaches this window
 * BEFORE the push's IPC response resolves — a revision guard alone cannot
 * recognize the echo. Three mechanisms compose:
 *
 * 1. Every push carries this window's `clientToken`; broadcasts echo it back
 *    as `sourceClientToken`, so a window can drop its own echoes outright.
 * 2. While a push is outstanding for a statePath, cross-writer broadcasts are
 *    deferred (not applied, not revision-noted) — main serializes writes per
 *    run, so the push's response record is at least as new as any broadcast
 *    sent before it and is the single value to reconcile against.
 * 3. The revision map records only revisions this window has actually
 *    APPLIED (or knowingly reconciled), never revisions merely seen — a seen
 *    but unapplied revision must not block a later legitimate adoption.
 */
import type { SprintEngineAutomationIntentRecord } from '../../../shared/sprintengine/automation-intent'
import type { SprintEngineAutomationMode, SprintEngineCliPermissionPreset } from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'

/** Identifies this window's pushes in broadcast echoes. */
export const SPRINT_ENGINE_AUTOMATION_CLIENT_TOKEN = (() => {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `client-${Math.random().toString(36).slice(2)}`
  } catch {
    return `client-${Math.random().toString(36).slice(2)}`
  }
})()

const appliedRevisionByStatePath = new Map<string, number>()
const outstandingPushesByStatePath = new Map<string, number>()

export function noteAppliedSprintEngineAutomationRevision(statePath: string, revision: number): void {
  const current = appliedRevisionByStatePath.get(statePath) ?? 0
  if (revision > current) appliedRevisionByStatePath.set(statePath, revision)
}

export function isStaleSprintEngineAutomationRevision(statePath: string, revision: number): boolean {
  return revision <= (appliedRevisionByStatePath.get(statePath) ?? 0)
}

export function hasOutstandingSprintEngineAutomationPush(statePath: string): boolean {
  return (outstandingPushesByStatePath.get(statePath) ?? 0) > 0
}

/** Test seam: forget all revision/push bookkeeping. */
export function resetSprintEngineAutomationRevisions(): void {
  appliedRevisionByStatePath.clear()
  outstandingPushesByStatePath.clear()
}

type PushSettledListener = (input: {
  statePath: string
  record: SprintEngineAutomationIntentRecord | null
}) => void

let pushSettledListener: PushSettledListener | null = null

/**
 * The mode-sync subscriber registers here to reconcile after each push
 * settles: the response record is the newest authoritative state at that
 * moment (main serializes per-run writes), superseding any broadcast that
 * was deferred while the push was in flight.
 */
export function setSprintEngineAutomationPushSettledListener(listener: PushSettledListener | null): void {
  pushSettledListener = listener
}

export type PushSprintEngineAutomationModeInput = {
  statePath: string
  mode: SprintEngineAutomationMode
  /**
   * Absent on a Sprints-door write (MC-1799): the run has no resident
   * workspace, and the `''` sentinel must never stand in for one — the write
   * is keyed by statePath, and the audit records no workspace rather than a
   * workspace that is not open.
   */
  workspaceId?: string
  workspaceName?: string
  reason?: string
  details?: string
  suppressManualAudit?: boolean
}

/** Open a push slot for a statePath; the returned function closes it. */
function beginPush(statePath: string): (record: SprintEngineAutomationIntentRecord | null) => void {
  outstandingPushesByStatePath.set(statePath, (outstandingPushesByStatePath.get(statePath) ?? 0) + 1)
  return (record) => {
    const remaining = (outstandingPushesByStatePath.get(statePath) ?? 1) - 1
    if (remaining <= 0) outstandingPushesByStatePath.delete(statePath)
    else outstandingPushesByStatePath.set(statePath, remaining)
    pushSettledListener?.({ statePath, record })
  }
}

/**
 * Write of the authoritative mode intent. Callers with a resident workspace
 * have already transitioned the local store optimistically and ignore the
 * result; main persists, audits, bridges cliWatchPolling, and broadcasts back.
 * A failed push is surfaced as a warning diagnostic — the renderer keeps
 * functioning on its local state, which is the pre-MC-1567 behavior for every
 * run.
 *
 * Resolves true only when main confirms the write, so the Sprints-door caller
 * — where this call IS the write, with no store transition behind it — can
 * report the change only once it actually happened (MC-1799).
 */
export function pushSprintEngineAutomationModeIntent(
  input: PushSprintEngineAutomationModeInput,
): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setSprintEngineAutomationMode) return Promise.resolve(false)
  const settle = beginPush(input.statePath)
  const reportFailure = (details: string): void => {
    publishDiagnosticSync({
      level: 'warning',
      source: 'sprintengine',
      title: 'Automation mode not persisted',
      message: 'The automation mode changed locally but the authoritative store could not be written.',
      details,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
    })
  }
  return api.setSprintEngineAutomationMode({
    statePath: input.statePath,
    mode: input.mode,
    clientToken: SPRINT_ENGINE_AUTOMATION_CLIENT_TOKEN,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(input.suppressManualAudit ? { suppressManualAudit: true } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
  })
    .then((result) => {
      if (result.ok) {
        noteAppliedSprintEngineAutomationRevision(input.statePath, result.record.revision)
        settle(result.record)
        return true
      }
      settle(null)
      reportFailure(result.message)
      return false
    })
    .catch((error) => {
      settle(null)
      reportFailure(error instanceof Error ? error.message : String(error))
      return false
    })
}

export type PushSprintEngineCliPermissionPresetInput = {
  statePath: string
  preset: SprintEngineCliPermissionPreset
  workspaceId?: string
  workspaceName?: string
}

/**
 * Write of the authoritative CLI permission preset (MC-1799). It shares the
 * mode's statePath-keyed home and echo bookkeeping, so a run's preset has one
 * writer whether the board is mounted on a workspace or on the Sprints door.
 * Resolves true only when main confirms the write.
 */
export function pushSprintEngineCliPermissionPresetIntent(
  input: PushSprintEngineCliPermissionPresetInput,
): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.setSprintEngineCliPermissionPreset) return Promise.resolve(false)
  const settle = beginPush(input.statePath)
  const reportFailure = (details: string): void => {
    publishDiagnosticSync({
      level: 'warning',
      source: 'sprintengine',
      title: 'CLI permissions not persisted',
      message: 'The CLI permission preset could not be written to this run’s store.',
      details,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
    })
  }
  return api.setSprintEngineCliPermissionPreset({
    statePath: input.statePath,
    preset: input.preset,
    clientToken: SPRINT_ENGINE_AUTOMATION_CLIENT_TOKEN,
  })
    .then((result) => {
      if (result.ok) {
        noteAppliedSprintEngineAutomationRevision(input.statePath, result.record.revision)
        settle(result.record)
        return true
      }
      settle(null)
      reportFailure(result.message)
      return false
    })
    .catch((error) => {
      settle(null)
      reportFailure(error instanceof Error ? error.message : String(error))
      return false
    })
}
