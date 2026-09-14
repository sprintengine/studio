import { createHash } from 'node:crypto'

import {
  SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND,
  SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND,
  type AutomationTriggerPollContext,
  type AutomationTriggerPollEvent,
  type AutomationTriggerProvider,
  type SprintEngineRunCompletedTriggerConfig,
  type SprintEngineRunNeedsInputTriggerConfig,
} from '../../../shared/automations/contracts'
import type { SprintEngineProjectionReadResult } from '../../../shared/electron-api'
import type { SprintEngineState } from '../../../shared/sprintengine/run-types'
import {
  isCanceledSprintEngineRun,
  isCompletedSprintEngineRun,
  normalizeSprintEngineProjection,
  sprintEngineHumanInputTasks,
} from '../../../shared/sprintengine/state'
import {
  SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID,
  type SprintEngineAutomationFrontDoors,
} from '../actions/sprint-engine'
import { workspaceSidecarPath } from '../../workspace-sidecar'

export {
  SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND,
  SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND,
}
export type { SprintEngineRunCompletedTriggerConfig, SprintEngineRunNeedsInputTriggerConfig }

// Two POLLING run-event triggers (MC-1656): the app initiates contact when a
// watched sprint blocks on a human question or finishes. Eventing is polling over
// `projection.json` on the engine's 60s tick — Main has no projection-change push
// channel — with the engine's persisted event-id dedupe (the same model as
// `automations.repo-event` and `sprint-engine.run-landed`). Both read through the
// Sprint Engine front doors, never the run store directly, and share the
// canonical run-state predicates in `src/shared/sprintengine/state.ts` so a run
// is judged identically here and in the renderer. Landed/PR-merge chaining is a
// separate, harder trigger (MC-1438, `sprint-engine-run-landed.ts`) and is not
// reproduced here.

// The watched team charset. Must start alphanumeric, so `.`/`..` and any
// path-traversal segment are rejected — the team is interpolated straight into a
// filesystem path below. Matches the sibling `sprint-engine-run-landed` trigger.
const TEAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

// Per-tick cache key for a run's raw projection read, so two run-event triggers
// (needs-input + completed) watching the same team share one disk read within an
// engine tick instead of each hitting `projection.json`.
const PROJECTION_CACHE_KEY_PREFIX = 'sprintengine:projection:'

// A `run-completed` fire is a one-shot per run instance whose dedupe id is
// deliberately task-set-INDEPENDENT (so re-blocks and task edits keep a stable
// fingerprint — see `sprintEngineRunFingerprint`). That makes it vulnerable to
// the same transient the `run-landed` trigger guards: task-completeness is
// briefly true while an architect plans incrementally (task 1 done before task 2
// is added), and a premature fire would BURN the fingerprint's dedupe id, masking
// the genuine completion forever. So completion must HOLD across this window
// before it fires; any not-completed observation resets it. Mirrors
// `LANDED_CONFIRMATION_MS`. Needs-input needs no such window — its ids carry the
// task id + `reportedAt`, so a transient never permanently masks a later block.
export const COMPLETED_CONFIRMATION_MS = 2 * 60_000

type ValidatedConfig<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Stable identity of a RUN INSTANCE, used to key event dedupe so a
 * delete-and-recreate of the team dir fires again (MC-1438's rule) while task
 * updates within one run keep the same fingerprint.
 *
 * `SprintEngineState` has no run-created stamp of its own (`updatedAt` mutates
 * constantly and must never be used). The stable field is on the projection:
 * `creation.createdAt`, written by the folder store at run creation — but it is
 * OPTIONAL. So: hash `creation.createdAt` when present, else fall back to
 * `name + goal`. Documented tradeoff: a recreated run with an identical name+goal
 * and no creation stamp dedupes against its predecessor — accepted rather than
 * inventing state. A leading discriminant keeps the two branches from ever
 * colliding (a name that happens to equal some other run's createdAt string).
 */
export function sprintEngineRunFingerprint(
  state: Pick<SprintEngineState, 'creation' | 'name' | 'goal'>,
): string {
  const createdAt = state.creation?.createdAt?.trim()
  const hash = createHash('sha256')
  if (createdAt) {
    hash.update('created-at\0')
    hash.update(createdAt)
  } else {
    hash.update('name-goal\0')
    hash.update(state.name)
    hash.update('\0')
    hash.update(state.goal)
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * `sprint-engine.run-completed` — fires ONCE per finished run instance. Predicate:
 * `isCompletedSprintEngineRun` (≥1 task and every task done) AND NOT
 * `isCanceledSprintEngineRun` (a canceled run is decided, not finished). The
 * completion must HOLD across `COMPLETED_CONFIRMATION_MS` before it fires, so a
 * transient all-done during incremental planning cannot burn the dedupe id (see
 * that constant). Event id `sprint-completed:<team>:<fingerprint>`, so the
 * engine's persisted dedupe makes every later poll a no-op while a recreated run
 * (new fingerprint) fires again.
 */
export function createSprintEngineRunCompletedTriggerProvider(
  frontDoors: Pick<SprintEngineAutomationFrontDoors, 'readProjection'>,
): AutomationTriggerProvider {
  // First observation of the current completion per watched store, for the
  // confirmation window. Provider-lifetime (the registry builds one provider per
  // app session); an app restart re-arms the window, which only delays an event
  // whose id the persisted dedupe already absorbs.
  const completedObservedAt = new Map<string, { fingerprint: string; since: number }>()
  return createRunEventTriggerProvider({
    kind: SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND,
    frontDoors,
    validate: (config) => validateRunEventTriggerConfig(config, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND),
    toEvents: ({ state, team, statePath, now }) => {
      if (isCanceledSprintEngineRun(state) || !isCompletedSprintEngineRun(state)) {
        completedObservedAt.delete(statePath)
        return []
      }
      // Only a completion that HOLDS fires. A not-completed observation above
      // clears the arming, so a transient all-done never survives to fire and can
      // never burn the true completion's dedupe id.
      const fingerprint = sprintEngineRunFingerprint(state)
      const observed = completedObservedAt.get(statePath)
      if (!observed || observed.fingerprint !== fingerprint) {
        completedObservedAt.set(statePath, { fingerprint, since: now })
        return []
      }
      if (now - observed.since < COMPLETED_CONFIRMATION_MS) return []
      return [{
        id: `sprint-completed:${team}:${fingerprint}`,
        occurredAt: new Date(now).toISOString(),
        payload: {
          kind: SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND,
          team,
          goal: state.goal,
          taskCount: state.tasks.length,
        },
      }]
    },
  })
}

/**
 * `sprint-engine.run-needs-input` — fires one event PER TASK blocked on a human
 * (`status === 'needs_input' && needsInput.kind === 'user'`, via
 * `sprintEngineHumanInputTasks`; architect-routed questions are deliberately
 * excluded because the engine can triage those itself). Skips entirely when the
 * run is canceled or completed. Event id
 * `sprint-needs-input:<team>:<fingerprint>:<taskId>:<reportedAt>`, so a task that
 * re-blocks later (new `reportedAt`) fires again while a redelivery of the same
 * blocker dedupes.
 *
 * `needsInput.reportedAt` is OPTIONAL: when a blocked task carries none, the id
 * uses the literal token `unreported`. Consequence: if the SAME task re-blocks
 * and again omits `reportedAt`, that re-block dedupes against the first instead
 * of refiring — accepted, because without a report timestamp there is no signal
 * to distinguish the two blocks.
 *
 * The payload carries everything a steward needs to answer via
 * `sprint.task.resolve_input` without a projection read of its own.
 */
export function createSprintEngineRunNeedsInputTriggerProvider(
  frontDoors: Pick<SprintEngineAutomationFrontDoors, 'readProjection'>,
): AutomationTriggerProvider {
  return createRunEventTriggerProvider({
    kind: SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND,
    frontDoors,
    validate: (config) => validateRunEventTriggerConfig(config, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND),
    toEvents: ({ state, team, now }) => {
      // needs-input is stateless across polls: no confirmation window, so it
      // ignores statePath. Its per-task ids carry taskId + reportedAt, which is
      // what keeps a transient block from permanently masking a real one.
      if (isCanceledSprintEngineRun(state) || isCompletedSprintEngineRun(state)) return []
      const fingerprint = sprintEngineRunFingerprint(state)
      const occurredAt = new Date(now).toISOString()
      return sprintEngineHumanInputTasks(state).map((task) => {
        const needsInput = task.needsInput
        const reportedAt = needsInput?.reportedAt?.trim() || 'unreported'
        return {
          id: `sprint-needs-input:${team}:${fingerprint}:${task.id}:${reportedAt}`,
          occurredAt,
          payload: {
            kind: SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND,
            team,
            taskId: task.id,
            taskTitle: task.title,
            question: needsInput?.question ?? '',
            ...(needsInput?.reason ? { reason: needsInput.reason } : {}),
            ...(needsInput?.suggestedResolution ? { suggestedResolution: needsInput.suggestedResolution } : {}),
            goal: state.goal,
          },
        }
      })
    },
  })
}

type RunEventTriggerOptions<T extends { kind: string; team: string }> = {
  kind: string
  frontDoors: Pick<SprintEngineAutomationFrontDoors, 'readProjection'>
  validate(config: unknown): ValidatedConfig<T>
  toEvents(input: { state: SprintEngineState; team: string; statePath: string; now: number }): AutomationTriggerPollEvent[]
}

function createRunEventTriggerProvider<T extends { kind: string; team: string }>(
  options: RunEventTriggerOptions<T>,
): AutomationTriggerProvider {
  return {
    kind: options.kind,
    requiredIntegrations: [SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID],
    configSchema: {
      type: 'object',
      required: ['kind', 'team'],
      properties: {
        kind: { const: options.kind },
        team: { type: 'string', minLength: 1 },
        label: { type: 'string', minLength: 1 },
      },
    },
    validateConfig(config) {
      const validation = options.validate(config)
      return validation.ok ? { ok: true } : validation
    },
    subscribe(input) {
      // Polling triggers never push; validate-then-no-op keeps the definition-write
      // path's subscribe check honest without arming a listener.
      const validation = options.validate(input.config)
      if (!validation.ok) throw new Error(validation.error)
      return () => undefined
    },
    async poll(input) {
      const validation = options.validate(input.config)
      if (!validation.ok) return { ok: false, blockedReason: validation.error }

      const team = validation.value.team
      const statePath = workspaceSidecarPath(input.workspaceRoot, 'sprintengine', team, 'run.yaml')
      const read = await readProjectionCached(options.frontDoors, statePath, input.context)
      if (!read.ok) return { ok: false, blockedReason: `Sprint run "${team}" is unreadable: ${read.message}` }

      const state = normalizeSprintEngineProjection(read.data, team)
      if (!state) return { ok: false, blockedReason: `Sprint run "${team}" has a malformed projection.` }

      return { ok: true, events: options.toEvents({ state, team, statePath, now: input.now() }) }
    },
  }
}

function readProjectionCached(
  frontDoors: Pick<SprintEngineAutomationFrontDoors, 'readProjection'>,
  statePath: string,
  context: AutomationTriggerPollContext | undefined,
): Promise<SprintEngineProjectionReadResult> {
  const read = () => frontDoors.readProjection({ statePath })
  return context
    ? context.getSharedValue(`${PROJECTION_CACHE_KEY_PREFIX}${statePath}`, read)
    : read()
}

export function validateSprintEngineRunNeedsInputTriggerConfig(
  config: unknown,
): ValidatedConfig<SprintEngineRunNeedsInputTriggerConfig> {
  return validateRunEventTriggerConfig(config, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND)
}

export function validateSprintEngineRunCompletedTriggerConfig(
  config: unknown,
): ValidatedConfig<SprintEngineRunCompletedTriggerConfig> {
  return validateRunEventTriggerConfig(config, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND)
}

function validateRunEventTriggerConfig<T extends { kind: string; team: string; label?: string }>(
  config: unknown,
  kind: string,
): ValidatedConfig<T> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, error: `Sprint run-event trigger config must be an object.` }
  }
  const record = config as Record<string, unknown>
  if (record.kind !== kind) {
    return { ok: false, error: `Sprint run-event trigger kind must be "${kind}".` }
  }
  const team = typeof record.team === 'string' ? record.team.trim() : ''
  if (!team || !TEAM_PATTERN.test(team)) {
    return { ok: false, error: 'Sprint run-event trigger team must be a safe sprint team directory name.' }
  }
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (record.label !== undefined && !label) {
    return { ok: false, error: 'Sprint run-event trigger label must be a non-empty string.' }
  }
  return { ok: true, value: { kind, team, ...(label ? { label } : {}) } as T }
}
