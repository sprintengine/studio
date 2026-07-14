import { scheduleCadenceSummaryWithZone } from '../../../shared/automations/cadence'
import { SCHEDULE_TRIGGER_KIND } from '../../../shared/automations/contracts'
import type { AutomationDefinition, AutomationRun } from '../../../shared/automations/contracts'
import {
  automationRecentRunsMax,
  automationRunTextMaxChars,
  automationsPerProjectMax,
} from '../../../shared/mobile-control/protocol'
import type {
  MobileControlAutomationRunSummary,
  MobileControlAutomationSnapshot,
} from '../../../shared/mobile-control/protocol'
import { validateScheduleTriggerConfig } from '../../automations/schedule'
import { AutomationsStore } from '../../automations/store'
import { deriveWorkspaceId } from './workspace-id'

// Projects one workspace root's automations for the mobile snapshot: a read-only
// monitor view (item 47). Nothing about the action, condition, prompt, worktree or
// connector is projected — the phone watches automations, the desktop authors them.
//
// SIZE IS THE CONSTRAINT. The snapshot rides the relay's 256 KB result-summary
// budget (bridge/command-results.ts), so the collection is bounded BY CONSTRUCTION,
// in the same style as the role-catalog caps: at most `automationsPerProjectMax`
// automations per root, each with at most `automationRecentRunsMax` runs, each run's
// free text truncated to `automationRunTextMaxChars`.
//
// The caps bound a PROJECT, not a snapshot, so they are a floor on the damage and
// not a proof of fit — enough roots at full cap still crowd the budget out. The
// shedding ladder (bridge/snapshot-request.ts) therefore drops `recentRuns` above
// the sprint engines: losing run history costs the phone monitor detail, whereas
// losing a sprint engine costs it a run it can no longer see or drive.
//
// Returns [] for a workspace with no automations store, and for one whose store
// cannot be read: an unreadable store is an absence of knowledge, not an empty
// project, and the projection carries no way to say "unknown" — inventing an empty
// automations list for a project that has them is the lie we can afford least.
export async function readMobileAutomationSnapshots(
  workspaceRoot: string,
  generatedAt: string,
): Promise<MobileControlAutomationSnapshot[]> {
  const store = new AutomationsStore(workspaceRoot)
  const definitions = await store.listDefinitions()
  if (!definitions.ok || definitions.values.length === 0) return []

  // The engine reads the next run as `definition.nextRunAt ?? state[id]` (engine.ts
  // scheduleDefinition), so the projection has to resolve it the same way or the
  // phone shows "no upcoming run" for an automation the engine has scheduled.
  const state = await store.readState()
  const nextRunAtById = (state.ok ? state.value?.nextRunAtByAutomationId : undefined) ?? {}

  const projectKey = deriveWorkspaceId(workspaceRoot)
  const zoneInstant = new Date(generatedAt)

  const selected = [...definitions.values].sort(compareDefinitionsNewestFirst).slice(0, automationsPerProjectMax)

  return Promise.all(
    selected.map(async (definition) => {
      const listed = await store.listRuns(definition.id)
      // Newest first (AutomationsStore.listRuns sorts by completion, then start, then
      // due), which is the order the wire contract promises for `recentRuns`.
      const runs = listed.ok ? listed.values : []
      // Resolved against every run, not just the five that ride the wire, so the
      // status stays right even when the cap drops the run it names.
      const lastRun = definition.lastRunId ? runs.find((run) => run.id === definition.lastRunId) : undefined
      const nextRunAt = definition.nextRunAt ?? nextRunAtById[definition.id] ?? null
      const cadence = renderCadence(definition, zoneInstant)
      const recentRuns = runs.slice(0, automationRecentRunsMax).map(toRunSummary)

      return {
        automationId: definition.id,
        projectKey,
        name: definition.name,
        status: definition.status,
        triggerKind: definition.trigger.kind,
        ...(cadence ? { cadence } : {}),
        ...isoField('nextRunAt', nextRunAt),
        ...isoField('lastRunAt', definition.lastRunAt),
        ...(lastRun ? { lastRunStatus: lastRun.status } : {}),
        ...(isRunInFlight(runs) ? { runInFlight: true } : {}),
        ...(recentRuns.length > 0 ? { recentRuns } : {}),
      }
    }),
  )
}

// Which automations survive the per-project cap. Most recently changed first: a
// project past the cap loses the automations nobody has touched, and the ordering
// is stable across snapshots (id breaks ties) so the phone's list does not churn.
function compareDefinitionsNewestFirst(left: AutomationDefinition, right: AutomationDefinition): number {
  const delta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  if (Number.isFinite(delta) && delta !== 0) return delta
  return left.id.localeCompare(right.id)
}

// Cadence is pre-rendered here because trigger `config` is provider-owned `unknown`
// and the phone must never parse it. Only a schedule trigger has a cadence at all;
// a repo-event or webhook trigger fires on an event, so it carries none and the
// phone renders the trigger kind alone.
//
// A schedule whose config the engine itself rejects (`validateScheduleTriggerConfig`
// — which includes every `cron` cadence, since no cron branch exists in the engine)
// gets NO cadence rather than a guessed one: the engine cannot schedule it either,
// and a fabricated cadence would present a dead automation as a live one.
function renderCadence(definition: AutomationDefinition, at: Date): string | undefined {
  if (definition.trigger.kind !== SCHEDULE_TRIGGER_KIND) return undefined
  const validation = validateScheduleTriggerConfig(definition.trigger.config)
  if (!validation.ok) return undefined
  return scheduleCadenceSummaryWithZone(validation.value, at)
}

// The run-now gate. `engine.runNow` rejects a second run with `in_flight`, so the
// phone must be able to see that a run is already going and not draw a button that
// is guaranteed to fail. Resolved against EVERY run, not the capped five that ride
// the wire, so the flag stays right when the cap drops the run that is in flight.
//
// The engine's own in-flight set is in-memory (engine.ts `inFlight`), so a store
// run left `running` by a desktop crash reads as in-flight here while the engine
// would in fact accept a run. That errs toward hiding the affordance, which is the
// safe direction: the phone offers nothing that fails, and the orphan sweep
// (reconcileOrphanedAgentRuns) clears the record.
function isRunInFlight(runs: AutomationRun[]): boolean {
  return runs.some((run) => run.status === 'running' || run.status === 'queued')
}

function toRunSummary(run: AutomationRun): MobileControlAutomationRunSummary {
  return {
    runId: run.id,
    status: run.status,
    // `startedAt` is what lets the phone age-qualify a `running` run. A run blocked
    // on a permission prompt has no finalize channel and sits `running` for hours
    // until a sweep fails it, so elapsed time is the only signal separating healthy
    // progress from a stuck run — without this the phone would render it as healthy.
    ...isoField('startedAt', run.startedAt),
    ...isoField('completedAt', run.completedAt),
    ...(run.blockedReason ? { blockedReason: truncateRunText(run.blockedReason) } : {}),
    ...(run.summary ? { summary: truncateRunText(run.summary) } : {}),
  }
}

// The snapshot validator (protocol.ts) rejects an explicit `null` and any string it
// cannot parse as a date, and it rejects the WHOLE snapshot for one bad field — so a
// single automation with a garbage timestamp on disk would blank the phone. Absent
// and unparseable both become "field omitted".
function isoField<Field extends string>(field: Field, value: string | null): Partial<Record<Field, string>> {
  if (!value || Number.isNaN(Date.parse(value))) return {}
  return { [field]: value } as Record<Field, string>
}

function truncateRunText(value: string): string {
  const text = value.trim()
  return text.length > automationRunTextMaxChars ? `${text.slice(0, automationRunTextMaxChars - 1)}…` : text
}
