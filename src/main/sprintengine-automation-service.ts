/**
 * Main-process owner of the Sprint Engine automation mode intent (MC-1567,
 * Phase 1 of the sprint-runtime-ownership epic).
 *
 * The authoritative three-state automation mode lives in an app-owned sidecar
 * (`automation.json` beside `run.yaml` — same precedent as the token ledger:
 * the engine neither reads nor validates it). Every writer — the desktop UI,
 * the mobile relay (MC-1497), a future scheduler/CLI — converges on
 * `setAutomationMode` here, so persistence, the manual-transition audit, the
 * headless `cliWatchPolling` bridge, and the renderer broadcast are structural
 * rather than per-caller discipline.
 *
 * Concurrency model: writes for one run serialize through a per-path promise
 * queue inside this process. Cross-process writers are not expected — the app
 * holds a single-instance lock (`app-lifecycle.ts`), so a second desktop
 * instance (which could fork revisions) never runs against the same runs.
 */
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type {
  DiagnosticLogInput,
  SprintEngineAutomationChangedEvent,
  SprintEngineAutomationReadResult,
  SprintEngineAutomationWriteResult,
} from '../shared/electron-api'
import type { SprintEngineAutomationMode } from '../shared/sprintengine/automation-types'
import {
  SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
  sprintEngineAutomationModeLabel,
} from '../shared/sprintengine/automation-types'
import {
  isSprintEngineAutomationMode,
  sprintEngineCliWatchPollingForAutomationMode,
} from '../shared/sprintengine/automation-lifecycle'
import {
  SPRINT_ENGINE_AUTOMATION_INTENT_FILE,
  nextSprintEngineAutomationIntentRecord,
  parseSprintEngineAutomationIntentRecord,
  serializeSprintEngineAutomationIntentRecord,
  type SprintEngineAutomationIntentActor,
  type SprintEngineAutomationIntentRecord,
  type SprintEngineAutomationRuntimeResidue,
} from '../shared/sprintengine/automation-intent'

export type { SprintEngineAutomationChangedEvent }

export type SetSprintEngineAutomationModeInput = {
  statePath: string
  mode: SprintEngineAutomationMode
  actor: SprintEngineAutomationIntentActor
  deviceId?: string | null
  // Echoed back on the broadcast so the pushing window can drop its own echo
  // (the broadcast reaches a window before the push's IPC response resolves).
  clientToken?: string
  // Audit context. `reason` mirrors the renderer store action's option; the
  // manual-transition audit is emitted only on a non-manual -> manual change
  // and only when not suppressed, exactly matching the renderer semantics this
  // path replaces. `taskId`/`agentId` keep the old audit record's deep-link
  // capability (navigationTarget) available to future callers.
  reason?: string
  details?: string
  suppressManualAudit?: boolean
  workspaceId?: string
  workspaceName?: string
  taskId?: string
  agentId?: string
}

export type SprintEngineAutomationServiceDeps = {
  // Bridges the persisted intent to the headless-CLI polling hint in run.yaml
  // (via the Python CLI). Best-effort: a failure is logged as a warning and
  // never fails the mode write — identical to the board panel's previous
  // direct-call semantics. Same-mode writes still reconcile the bridge when a
  // previous attempt failed (the old UI retried on re-toggle; see MC-1567
  // review finding: without this, a bridge failure was unrecoverable short of
  // flipping the mode twice).
  setRunnerCliWatchPolling: (input: {
    statePath: string
    cliWatchPolling: 'enabled' | 'disabled'
  }) => Promise<{ ok: boolean; message?: string }>
  logDiagnostic: (input: DiagnosticLogInput) => void
  broadcast: (event: SprintEngineAutomationChangedEvent) => void
  /**
   * Called when `hydrateAutomationMode` seeds a sidecar (first write). The
   * hydration deliberately does not `broadcast` to windows (the seeding
   * renderer already holds the value), but the main scheduler still has to
   * adopt the now-authoritative mode — without this a freshly created run
   * would sit at `manual` in the scheduler until an explicit mode toggle.
   */
  notifyHydrated?: (statePath: string, record: SprintEngineAutomationIntentRecord) => void
  now?: () => number
}

export type SprintEngineAutomationService = ReturnType<typeof createSprintEngineAutomationService>

function automationIntentPathForState(statePath: string): { intentPath: string; queueKey: string } | null {
  const normalized = statePath?.trim()
  if (!normalized || basename(normalized) !== 'run.yaml') return null
  // Resolve so path aliases of the same run.yaml share one write queue and
  // one sidecar file (symlinks aside).
  const resolved = resolve(normalized)
  const teamDirectory = dirname(resolved)
  if (!existsSync(teamDirectory)) return null
  return { intentPath: join(teamDirectory, SPRINT_ENGINE_AUTOMATION_INTENT_FILE), queueKey: resolved }
}

export function createSprintEngineAutomationService(deps: SprintEngineAutomationServiceDeps) {
  const now = deps.now ?? (() => Date.now())
  // Read-modify-write cycles for one run must not interleave (UI and phone can
  // write concurrently), so every mutation for a statePath queues behind the
  // previous one. Reads go through the same queue to observe settled state.
  const writeQueues = new Map<string, Promise<unknown>>()
  // The cliWatchPolling value last successfully written to run.yaml, per queue
  // key. Absent = never bridged (or last attempt failed) -> reconcile on the
  // next write, even a same-mode one.
  const bridgedCliWatchPolling = new Map<string, 'enabled' | 'disabled'>()

  function enqueue<T>(queueKey: string, task: () => Promise<T>): Promise<T> {
    const tail = writeQueues.get(queueKey) ?? Promise.resolve()
    const next = tail.then(task, task)
    const settled = next.catch(() => undefined)
    writeQueues.set(queueKey, settled)
    // Evict once this chain fully settles and nothing newer replaced it, so
    // long sessions don't accumulate one entry per run forever.
    void settled.then(() => {
      if (writeQueues.get(queueKey) === settled) writeQueues.delete(queueKey)
    })
    return next
  }

  async function readRecord(intentPath: string): Promise<SprintEngineAutomationIntentRecord | null> {
    let raw: string
    try {
      raw = await readFile(intentPath, 'utf8')
    } catch {
      return null
    }
    try {
      return parseSprintEngineAutomationIntentRecord(JSON.parse(raw))
    } catch {
      return null
    }
  }

  async function writeRecordAtomically(
    intentPath: string,
    record: SprintEngineAutomationIntentRecord,
  ): Promise<void> {
    const tmpPath = `${intentPath}.tmp-${process.pid}`
    await writeFile(tmpPath, serializeSprintEngineAutomationIntentRecord(record), 'utf8')
    try {
      await rename(tmpPath, intentPath)
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined)
      throw error
    }
  }

  function auditManualTransition(
    input: SetSprintEngineAutomationModeInput,
    previousMode: SprintEngineAutomationMode,
  ): void {
    // A pre-hydration sidecar (no record yet) defaults the previous mode to
    // manual, which suppresses this audit — an accepted first-write blind spot:
    // the sidecar is the authority, and before it exists there is no
    // authoritative previous mode to attribute.
    if (input.mode !== 'manual' || previousMode === 'manual') return
    if (input.suppressManualAudit) return
    const writerLine = input.actor === 'ui'
      ? undefined
      : `Writer: ${input.actor}${input.deviceId ? ` (${input.deviceId})` : ''}`
    deps.logDiagnostic({
      level: 'info',
      source: 'sprintengine',
      title: SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
      message: `Manual: ${input.reason ?? 'Sprint automation mode was set to Manual.'}`,
      details: [
        `Previous mode: ${sprintEngineAutomationModeLabel(previousMode)}`,
        input.details,
        writerLine,
      ].filter((line): line is string => Boolean(line)).join('\n'),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.taskId ? { navigationTarget: { kind: 'task' as const, ref: input.taskId } } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    })
  }

  function reconcileCliWatchPollingBridge(
    input: Pick<SetSprintEngineAutomationModeInput, 'statePath' | 'mode' | 'workspaceId' | 'workspaceName'>,
    queueKey: string,
  ): void {
    const cliWatchPolling = sprintEngineCliWatchPollingForAutomationMode(input.mode)
    if (bridgedCliWatchPolling.get(queueKey) === cliWatchPolling) return
    const reportFailure = (details: string): void => {
      deps.logDiagnostic({
        level: 'warning',
        source: 'sprintengine',
        title: 'Runner polling flag not updated',
        message: `The automation mode changed but run.yaml's cliWatchPolling hint could not be written (${cliWatchPolling}). Re-selecting the mode retries.`,
        details,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
      })
    }
    void deps.setRunnerCliWatchPolling({ statePath: input.statePath, cliWatchPolling })
      .then((result) => {
        if (result.ok) {
          bridgedCliWatchPolling.set(queueKey, cliWatchPolling)
          return
        }
        reportFailure(result.message ?? 'Unknown error.')
      })
      .catch((error) => {
        reportFailure(error instanceof Error ? error.message : String(error))
      })
  }

  return {
    async readAutomationMode(input: { statePath: string }): Promise<SprintEngineAutomationReadResult> {
      const paths = automationIntentPathForState(input.statePath)
      if (!paths) return { ok: false, message: 'Sprint run state path is not a readable run.yaml location.' }
      return enqueue(paths.queueKey, async () => ({
        ok: true as const,
        record: await readRecord(paths.intentPath),
      }))
    },

    async setAutomationMode(input: SetSprintEngineAutomationModeInput): Promise<SprintEngineAutomationWriteResult> {
      if (!isSprintEngineAutomationMode(input.mode)) {
        return { ok: false, message: `Unknown automation mode: ${String(input.mode)}` }
      }
      const paths = automationIntentPathForState(input.statePath)
      if (!paths) return { ok: false, message: 'Sprint run state path is not a writable run.yaml location.' }

      return enqueue(paths.queueKey, async () => {
        const current = await readRecord(paths.intentPath)
        if (current && current.desiredMode === input.mode) {
          // Idempotent no-op: no revision bump, no audit, no broadcast — a
          // same-mode click or an echo must not look like a new transition.
          // The bridge still reconciles (a previously failed run.yaml write
          // must be retryable by re-selecting the mode).
          reconcileCliWatchPollingBridge(input, paths.queueKey)
          return { ok: true as const, record: current, changed: false }
        }
        const record = nextSprintEngineAutomationIntentRecord({
          current,
          mode: input.mode,
          actor: input.actor,
          deviceId: input.deviceId ?? null,
          now: now(),
        })
        try {
          await writeRecordAtomically(paths.intentPath, record)
        } catch (error) {
          return {
            ok: false as const,
            message: `Automation mode could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
        auditManualTransition(input, current?.desiredMode ?? 'manual')
        reconcileCliWatchPollingBridge(input, paths.queueKey)
        deps.broadcast({
          statePath: input.statePath,
          record,
          ...(input.clientToken ? { sourceClientToken: input.clientToken } : {}),
        })
        return { ok: true as const, record, changed: true }
      })
    },

    /**
     * Scheduler bookkeeping persistence (Phase 3): merge the runtime residue
     * into the record WITHOUT bumping the revision, auditing, bridging, or
     * broadcasting — it is durable bookkeeping beside the intent, not a
     * transition. No-ops when no intent record exists yet (the residue is
     * meaningless before the run's mode has ever been written/hydrated).
     */
    async updateRuntimeResidue(input: {
      statePath: string
      runtime: SprintEngineAutomationRuntimeResidue
    }): Promise<void> {
      const paths = automationIntentPathForState(input.statePath)
      if (!paths) return
      await enqueue(paths.queueKey, async () => {
        const current = await readRecord(paths.intentPath)
        if (!current) return
        try {
          await writeRecordAtomically(paths.intentPath, { ...current, runtime: input.runtime })
        } catch {
          // Best-effort: in-memory scheduler state still applies; the next
          // residue change retries.
        }
      })
    },

    /**
     * One-time migration seam: seed the sidecar from the legacy renderer-owned
     * value, only when no sidecar exists yet. No audit (nothing transitioned),
     * no cliWatchPolling bridge (run.yaml already reflects the old UI's own
     * writes), no broadcast (the seeding renderer already holds this value and
     * a fresh window reads before hydrating).
     */
    async hydrateAutomationMode(input: {
      statePath: string
      mode: SprintEngineAutomationMode
    }): Promise<SprintEngineAutomationWriteResult> {
      if (!isSprintEngineAutomationMode(input.mode)) {
        return { ok: false, message: `Unknown automation mode: ${String(input.mode)}` }
      }
      const paths = automationIntentPathForState(input.statePath)
      if (!paths) return { ok: false, message: 'Sprint run state path is not a writable run.yaml location.' }

      return enqueue(paths.queueKey, async () => {
        const current = await readRecord(paths.intentPath)
        if (current) return { ok: true as const, record: current, changed: false }
        const record = nextSprintEngineAutomationIntentRecord({
          current: null,
          mode: input.mode,
          actor: 'system',
          deviceId: null,
          now: now(),
        })
        try {
          await writeRecordAtomically(paths.intentPath, record)
        } catch (error) {
          return {
            ok: false as const,
            message: `Automation mode could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
        deps.notifyHydrated?.(input.statePath, record)
        return { ok: true as const, record, changed: true }
      })
    },
  }
}
