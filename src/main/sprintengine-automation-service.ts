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
 */
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { DiagnosticLogInput } from '../shared/electron-api'
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
} from '../shared/sprintengine/automation-intent'

export type SprintEngineAutomationChangedEvent = {
  statePath: string
  record: SprintEngineAutomationIntentRecord
}

export type SprintEngineAutomationReadResult =
  | { ok: true; record: SprintEngineAutomationIntentRecord | null }
  | { ok: false; message: string }

export type SprintEngineAutomationWriteResult =
  | { ok: true; record: SprintEngineAutomationIntentRecord; changed: boolean }
  | { ok: false; message: string }

export type SetSprintEngineAutomationModeInput = {
  statePath: string
  mode: SprintEngineAutomationMode
  actor: SprintEngineAutomationIntentActor
  deviceId?: string | null
  // Audit context. `reason` mirrors the renderer store action's option; the
  // manual-transition audit is emitted only on a non-manual -> manual change
  // and only when not suppressed, exactly matching the renderer semantics this
  // path replaces.
  reason?: string
  details?: string
  suppressManualAudit?: boolean
  workspaceId?: string
  workspaceName?: string
}

export type SprintEngineAutomationServiceDeps = {
  // Bridges the persisted intent to the headless-CLI polling hint in run.yaml
  // (via the Python CLI). Best-effort: a failure is logged as a warning and
  // never fails the mode write — identical to the board panel's previous
  // direct-call semantics.
  setRunnerCliWatchPolling: (input: {
    statePath: string
    cliWatchPolling: 'enabled' | 'disabled'
  }) => Promise<{ ok: boolean; message?: string }>
  logDiagnostic: (input: DiagnosticLogInput) => void
  broadcast: (event: SprintEngineAutomationChangedEvent) => void
  now?: () => number
}

export type SprintEngineAutomationService = ReturnType<typeof createSprintEngineAutomationService>

function automationIntentPathForState(statePath: string): string | null {
  const normalized = statePath?.trim()
  if (!normalized || basename(normalized) !== 'run.yaml') return null
  const teamDirectory = dirname(normalized)
  if (!existsSync(teamDirectory)) return null
  return join(teamDirectory, SPRINT_ENGINE_AUTOMATION_INTENT_FILE)
}

export function createSprintEngineAutomationService(deps: SprintEngineAutomationServiceDeps) {
  const now = deps.now ?? (() => Date.now())
  // Read-modify-write cycles for one run must not interleave (UI and phone can
  // write concurrently), so every mutation for a statePath queues behind the
  // previous one. Reads go through the same queue to observe settled state.
  const writeQueues = new Map<string, Promise<unknown>>()

  function enqueue<T>(statePath: string, task: () => Promise<T>): Promise<T> {
    const tail = writeQueues.get(statePath) ?? Promise.resolve()
    const next = tail.then(task, task)
    writeQueues.set(statePath, next.catch(() => undefined))
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
    })
  }

  function bridgeCliWatchPolling(statePath: string, mode: SprintEngineAutomationMode): void {
    const cliWatchPolling = sprintEngineCliWatchPollingForAutomationMode(mode)
    void deps.setRunnerCliWatchPolling({ statePath, cliWatchPolling })
      .then((result) => {
        if (result.ok) return
        deps.logDiagnostic({
          level: 'warning',
          source: 'sprintengine',
          title: 'Runner polling flag not updated',
          message: `The automation mode changed but run.yaml's cliWatchPolling hint could not be written (${cliWatchPolling}).`,
          ...(result.message ? { details: result.message } : {}),
        })
      })
      .catch((error) => {
        deps.logDiagnostic({
          level: 'warning',
          source: 'sprintengine',
          title: 'Runner polling flag not updated',
          message: `The automation mode changed but run.yaml's cliWatchPolling hint could not be written (${cliWatchPolling}).`,
          details: error instanceof Error ? error.message : String(error),
        })
      })
  }

  return {
    async readAutomationMode(input: { statePath: string }): Promise<SprintEngineAutomationReadResult> {
      const intentPath = automationIntentPathForState(input.statePath)
      if (!intentPath) return { ok: false, message: 'Sprint run state path is not a readable run.yaml location.' }
      return enqueue(input.statePath, async () => ({
        ok: true as const,
        record: await readRecord(intentPath),
      }))
    },

    async setAutomationMode(input: SetSprintEngineAutomationModeInput): Promise<SprintEngineAutomationWriteResult> {
      if (!isSprintEngineAutomationMode(input.mode)) {
        return { ok: false, message: `Unknown automation mode: ${String(input.mode)}` }
      }
      const intentPath = automationIntentPathForState(input.statePath)
      if (!intentPath) return { ok: false, message: 'Sprint run state path is not a writable run.yaml location.' }

      return enqueue(input.statePath, async () => {
        const current = await readRecord(intentPath)
        if (current && current.desiredMode === input.mode) {
          // Idempotent no-op: no revision bump, no audit, no broadcast — a
          // same-mode click or an echo must not look like a new transition.
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
          await writeRecordAtomically(intentPath, record)
        } catch (error) {
          return {
            ok: false as const,
            message: `Automation mode could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
        auditManualTransition(input, current?.desiredMode ?? 'manual')
        bridgeCliWatchPolling(input.statePath, input.mode)
        deps.broadcast({ statePath: input.statePath, record })
        return { ok: true as const, record, changed: true }
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
      const intentPath = automationIntentPathForState(input.statePath)
      if (!intentPath) return { ok: false, message: 'Sprint run state path is not a writable run.yaml location.' }

      return enqueue(input.statePath, async () => {
        const current = await readRecord(intentPath)
        if (current) return { ok: true as const, record: current, changed: false }
        const record = nextSprintEngineAutomationIntentRecord({
          current: null,
          mode: input.mode,
          actor: 'system',
          deviceId: null,
          now: now(),
        })
        try {
          await writeRecordAtomically(intentPath, record)
        } catch (error) {
          return {
            ok: false as const,
            message: `Automation mode could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
        return { ok: true as const, record, changed: true }
      })
    },
  }
}
