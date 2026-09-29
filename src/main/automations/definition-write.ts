import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type {
  AutomationActionProvider,
  AutomationApprovalSource,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationTriggerProvider,
  AutomationsResult,
} from '../../shared/automations/contracts'
import { SCHEDULE_TRIGGER_KIND } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { projectFoldersFromWorkspaceSyncSnapshot } from './engine'
import {
  automationProviderBlockedReason,
  type AutomationProviderPermissionChecker,
  type RegisteredAutomationProvider,
} from './provider-registry'
import { computeNextRun, isValidTimeZone, scheduleCadenceCanExhaust, validateScheduleTriggerConfig } from './schedule'
import { AutomationsStore, type AutomationStoreProblem } from './store'
import type { AutomationApprovalLedger } from './approval-ledger'
import { isRecord } from '../../shared/records'

// The one write path for automation definitions. Both front doors — the
// user-facing IPC handlers (automations-ipc.ts) and the module-scoped service
// (module-service.ts) — route create/update/delete through this core, so
// draft/patch validation, provider + schedule validation, `nextRunAt`
// computation, the next-run state cache, and the definitions-changed
// notification (webhook receiver refresh) cannot drift between callers.

// Deliberately excludes `ownerModuleId` and the `sourceCatalogueId` /
// `sourcePublisher` provenance pair: all three are stamped once at create and
// are immutable, so no patch may carry them.
export type ParsedDefinitionPatch = Partial<
  Pick<
    AutomationDefinition,
    'name' | 'status' | 'trigger' | 'condition' | 'action' | 'runInWorktree' | 'disableAfterRun'
  >
>

/**
 * A marketplace catalogue entry's automation payload, plus the provenance the
 * host stamps onto the record it creates. `payload` stays `unknown` — the parse
 * below is the authoritative one; the bundle manifest's structural check is not.
 */
type CatalogueDefinitionInstallInput = {
  payload: unknown
  sourceCatalogueId: string
  sourcePublisher?: string
}

type CatalogueDefinitionInstall = {
  definition: AutomationDefinition
  /** True when the project already had this catalogue entry: nothing was written. */
  alreadyAdded: boolean
}

const AUTOMATION_STATUSES = new Set(['enabled', 'paused', 'blocked'])

export type DefinitionWriteDeps = {
  createStore: (workspaceRoot: string) => AutomationsStore
  getTriggerProviderRegistrations: () => RegisteredAutomationProvider<AutomationTriggerProvider>[]
  getActionProviderRegistrations: () => RegisteredAutomationProvider<AutomationActionProvider>[]
  checkProviderPermission: AutomationProviderPermissionChecker
  now: () => number
  createAutomationId?: (draft: AutomationDefinitionDraft) => string
  /**
   * The zone a catalogue schedule is resolved into at install. Defaults to the
   * host's own IANA zone, which is what the renderer's editor already stamps on
   * a schedule the user authors — injected only so tests can install as a user
   * somewhere else.
   */
  hostTimeZone?: () => string
  /**
   * Post-write hook (e.g. webhook receiver refresh, renderer notification). A
   * throw never fails the operation — the write already persisted — it is
   * surfaced as `postWriteFailure` on the success result for each front door
   * to report in its own vocabulary.
   */
  onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>
  /**
   * The approval ledger, and who this front door's writes come from. A write
   * through the app is its author's own, so it is recorded as approved as it
   * lands — a created automation, and an edit to one that was already approved,
   * never ask. An edit to one that is waiting (the pause toggle on a file a
   * clone brought in) leaves it waiting: that click was not a review of the
   * rest of the file. Absent ⇒ nothing is recorded, so what this core writes
   * waits for a review — the safe failure for a front door that forgot to wire
   * it.
   */
  approvals?: { ledger: AutomationApprovalLedger; source: AutomationApprovalSource }
}

type PostWriteFailure = { code: string; message: string }

export type DefinitionWriteResult<T> =
  { ok: true; value: T; postWriteFailure?: PostWriteFailure } | { ok: false; code: string; message: string }

/**
 * Evaluated against the record read inside the same read→write sequence, so a
 * caller's guard (e.g. module ownership) cannot be split from the write by a
 * concurrent delete-and-recreate between two separate reads.
 */
export type DefinitionPrecondition = (
  existing: AutomationDefinition,
) => { ok: true } | { ok: false; code: string; message: string }

export type DefinitionWriteCore = {
  get(workspaceRoot: string, automationId: string): Promise<DefinitionWriteResult<AutomationDefinition>>
  create(workspaceRoot: string, draft: AutomationDefinitionDraft): Promise<DefinitionWriteResult<AutomationDefinition>>
  /**
   * The marketplace install path: parse a catalogue payload, resolve the install
   * defaults, stamp provenance, and create — or report the entry as already
   * added when this project has it. The third front door onto this core, so a
   * shelf install gets the same validation, next-run computation, next-run cache
   * write and definitions-changed notification the panel and modules get.
   */
  installFromCatalogue(
    workspaceRoot: string,
    input: CatalogueDefinitionInstallInput,
  ): Promise<DefinitionWriteResult<CatalogueDefinitionInstall>>
  update(
    workspaceRoot: string,
    automationId: string,
    patch: ParsedDefinitionPatch,
    precondition?: DefinitionPrecondition,
  ): Promise<DefinitionWriteResult<AutomationDefinition>>
  remove(
    workspaceRoot: string,
    automationId: string,
    precondition?: DefinitionPrecondition,
  ): Promise<DefinitionWriteResult<{ automationId: string }>>
}

export function createDefinitionWriteCore(deps: DefinitionWriteDeps): DefinitionWriteCore {
  async function notifyDefinitionsChanged(workspaceRoot: string): Promise<PostWriteFailure | undefined> {
    try {
      await deps.onDefinitionsChanged?.(workspaceRoot)
      return undefined
    } catch (error) {
      return {
        code: 'webhook_receiver_refresh_failed',
        message: error instanceof Error ? error.message : 'Webhook receiver refresh failed.',
      }
    }
  }

  async function finishWrite<T>(
    workspaceRoot: string,
    value: T,
    approvalFailure?: PostWriteFailure,
  ): Promise<DefinitionWriteResult<T>> {
    const postWriteFailure = (await notifyDefinitionsChanged(workspaceRoot)) ?? approvalFailure
    return postWriteFailure ? { ok: true, value, postWriteFailure } : { ok: true, value }
  }

  // Recorded after the definition is on disk and before the definitions-changed
  // hook wakes the engine, so the evaluation that wake starts already finds it
  // approved. A failed ledger write does not undo the definition: it stays
  // written and waits for a review, and the caller hears why.
  async function recordApproval(
    workspaceRoot: string,
    definition: AutomationDefinition,
  ): Promise<PostWriteFailure | undefined> {
    if (!deps.approvals) return undefined
    try {
      await deps.approvals.ledger.approve(workspaceRoot, definition, deps.approvals.source)
      return undefined
    } catch (error) {
      return {
        code: 'approval_record_failed',
        message: `Saved, but it could not be marked as yours, so it will ask before it runs: ${
          error instanceof Error ? error.message : 'the approval ledger could not be written.'
        }`,
      }
    }
  }

  async function wasApproved(workspaceRoot: string, definition: AutomationDefinition): Promise<boolean> {
    if (!deps.approvals) return false
    try {
      return (await deps.approvals.ledger.check(workspaceRoot, definition)).state === 'approved'
    } catch {
      return false
    }
  }

  async function createDefinition(
    workspaceRoot: string,
    draft: AutomationDefinitionDraft,
  ): Promise<DefinitionWriteResult<AutomationDefinition>> {
    const timestamp = new Date(deps.now()).toISOString()
    const withPairDefaults = applyProviderPairDefaults(draft, deps.getTriggerProviderRegistrations())
    const definition = buildDefinitionForCreate(withPairDefaults, timestamp, deps.createAutomationId)
    const prepared = prepareDefinitionForWrite(
      definition,
      deps.getTriggerProviderRegistrations(),
      deps.getActionProviderRegistrations(),
      deps.checkProviderPermission,
      deps.now(),
    )
    if (!prepared.ok) return prepared

    const store = deps.createStore(workspaceRoot)
    const created = await store.createDefinition(prepared.value)
    if (!created.ok) return storeError(created.error)
    const state = await writeNextRunCache(store, prepared.value.id, prepared.value.nextRunAt)
    if (!state.ok) return storeError(state.error)
    const approvalFailure = await recordApproval(workspaceRoot, created.value)
    return finishWrite(workspaceRoot, created.value, approvalFailure)
  }

  return {
    async get(workspaceRoot, automationId) {
      const definition = await deps.createStore(workspaceRoot).getDefinition(automationId)
      if (!definition.ok) return storeError(definition.error)
      return { ok: true, value: definition.value }
    },

    create: createDefinition,

    async installFromCatalogue(workspaceRoot, input) {
      const sourceCatalogueId = input.sourceCatalogueId.trim()
      if (!sourceCatalogueId) {
        return fail('invalid_input', 'sourceCatalogueId is required to install a catalogue automation.')
      }
      // Parse first: a payload that does not parse writes nothing at all, and
      // this runs before the store is read, let alone written.
      const draft = parseDefinitionDraft(catalogueDraftInput(input.payload, resolveHostTimeZone(deps.hostTimeZone)))
      if (!draft.ok) return draft

      const store = deps.createStore(workspaceRoot)
      const existing = await store.listDefinitions()
      if (!existing.ok) return storeError(existing.errors[0])
      const added = existing.values.find((definition) => definition.sourceCatalogueId === sourceCatalogueId)
      if (added) return { ok: true, value: { definition: added, alreadyAdded: true } }

      const sourcePublisher = input.sourcePublisher?.trim()
      const created = await createDefinition(workspaceRoot, {
        ...draft.value,
        sourceCatalogueId,
        ...(sourcePublisher ? { sourcePublisher } : {}),
      })
      if (!created.ok) return created
      const value: CatalogueDefinitionInstall = { definition: created.value, alreadyAdded: false }
      return created.postWriteFailure
        ? { ok: true, value, postWriteFailure: created.postWriteFailure }
        : { ok: true, value }
    },

    async update(workspaceRoot, automationId, patch, precondition) {
      const store = deps.createStore(workspaceRoot)
      const existing = await store.getDefinition(automationId)
      if (!existing.ok) return storeError(existing.error)
      const admitted = precondition?.(existing.value) ?? { ok: true as const }
      if (!admitted.ok) return admitted
      // Read before the write: whether the file as it stood was approved decides
      // whether the edit carries the approval forward.
      const approvedBefore = await wasApproved(workspaceRoot, existing.value)

      const timestamp = new Date(deps.now()).toISOString()
      const updated: AutomationDefinition = {
        ...existing.value,
        ...patch,
        id: existing.value.id,
        createdAt: existing.value.createdAt,
        updatedAt: timestamp,
      }
      const prepared = prepareDefinitionForWrite(
        updated,
        deps.getTriggerProviderRegistrations(),
        deps.getActionProviderRegistrations(),
        deps.checkProviderPermission,
        deps.now(),
      )
      if (!prepared.ok) return prepared

      const written = await store.updateDefinition(prepared.value)
      if (!written.ok) return storeError(written.error)
      const state = await writeNextRunCache(store, prepared.value.id, prepared.value.nextRunAt)
      if (!state.ok) return storeError(state.error)
      const approvalFailure = approvedBefore ? await recordApproval(workspaceRoot, written.value) : undefined
      return finishWrite(workspaceRoot, written.value, approvalFailure)
    },

    async remove(workspaceRoot, automationId, precondition) {
      const store = deps.createStore(workspaceRoot)
      if (precondition) {
        const existing = await store.getDefinition(automationId)
        if (!existing.ok) return storeError(existing.error)
        const admitted = precondition(existing.value)
        if (!admitted.ok) return admitted
      }
      const deleted = await store.deleteDefinition(automationId)
      if (!deleted.ok) return storeError(deleted.error)
      const state = await writeNextRunCache(store, automationId, null, true)
      if (!state.ok) return storeError(state.error)
      // A file that comes back under the same id (a revert, a pull) is a new
      // file as far as this machine knows, and asks again. Best-effort: a stale
      // entry only matches the exact content that was deleted.
      await deps.approvals?.ledger.revoke(workspaceRoot, automationId).catch(() => undefined)
      return finishWrite(workspaceRoot, { automationId })
    },
  }
}

/**
 * A write may only target a folder the workspace-sync snapshot knows about:
 * anything else would create records the engine's project-folder scan never
 * schedules and no panel ever lists. Both front doors (user IPC, module
 * service) run this before touching a store. Returns the canonical folder
 * path on success.
 */
export function validateKnownWorkspaceRoot(
  workspaceRoot: string,
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined,
): AutomationsResult<string> {
  if (!isAbsolute(workspaceRoot)) {
    return fail('invalid_input', 'workspaceRoot must be an absolute path.')
  }
  if (!getWorkspaceSyncSnapshot) {
    return fail('workspace_root_unverified', 'workspaceRoot cannot be verified against the workspace snapshot.')
  }

  try {
    const workspaceRootKey = normalizeWorkspaceRoot(workspaceRoot)
    const knownFolder = projectFoldersFromWorkspaceSyncSnapshot(getWorkspaceSyncSnapshot()).find(
      (folder) => normalizeWorkspaceRoot(folder.folderPath) === workspaceRootKey,
    )
    if (!knownFolder) {
      return fail('workspace_root_untrusted', 'workspaceRoot must match an open workspace folder.')
    }
    return ok(knownFolder.folderPath.trim())
  } catch (error) {
    return fail(
      'workspace_snapshot_unavailable',
      error instanceof Error ? error.message : 'Unable to verify workspaceRoot against the workspace snapshot.',
    )
  }
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function buildDefinitionForCreate(
  draft: AutomationDefinitionDraft,
  timestamp: string,
  createAutomationId?: (draft: AutomationDefinitionDraft) => string,
): AutomationDefinition {
  return {
    id: draft.id?.trim() || createAutomationId?.(draft) || defaultAutomationId(draft.name),
    name: draft.name.trim(),
    status: draft.status,
    trigger: draft.trigger,
    condition: draft.condition,
    action: draft.action,
    ...(draft.runInWorktree === undefined ? {} : { runInWorktree: draft.runInWorktree }),
    ...(draft.disableAfterRun === undefined ? {} : { disableAfterRun: draft.disableAfterRun }),
    ...(draft.ownerModuleId === undefined ? {} : { ownerModuleId: draft.ownerModuleId }),
    ...(draft.sourceCatalogueId === undefined ? {} : { sourceCatalogueId: draft.sourceCatalogueId }),
    ...(draft.sourcePublisher === undefined ? {} : { sourcePublisher: draft.sourcePublisher }),
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function prepareDefinitionForWrite(
  definition: AutomationDefinition,
  triggerProviders: RegisteredAutomationProvider<AutomationTriggerProvider>[],
  actionProviders: RegisteredAutomationProvider<AutomationActionProvider>[],
  checkProviderPermission: AutomationProviderPermissionChecker,
  after: number,
): AutomationsResult<AutomationDefinition> {
  const triggerRegistration = triggerProviders.find((registration) => registration.kind === definition.trigger.kind)
  if (!triggerRegistration) {
    return fail('unknown_trigger', `No automation trigger provider is registered for "${definition.trigger.kind}".`)
  }
  const triggerBlockedReason = automationProviderBlockedReason(
    triggerRegistration,
    checkProviderPermission(triggerRegistration),
  )
  if (triggerBlockedReason) return fail('provider_blocked', triggerBlockedReason)

  const actionRegistration = actionProviders.find((registration) => registration.kind === definition.action.kind)
  if (!actionRegistration) {
    return fail('unknown_action', `No automation action provider is registered for "${definition.action.kind}".`)
  }
  const actionBlockedReason = automationProviderBlockedReason(
    actionRegistration,
    checkProviderPermission(actionRegistration),
  )
  if (actionBlockedReason) return fail('provider_blocked', actionBlockedReason)

  const triggerProvider = triggerRegistration.provider

  if (definition.trigger.kind === 'schedule') {
    const validation = validateScheduleTriggerConfig(definition.trigger.config)
    if (!validation.ok) return fail('invalid_schedule', validation.error)

    if (definition.status !== 'enabled') {
      return ok({ ...definition, nextRunAt: null })
    }

    const nextRunAt = computeNextRun(validation.value, after)
    if (nextRunAt === null) {
      // A one-shot whose datetime already passed is valid — it simply has no
      // upcoming run (documented; also what an already-fired `at` automation
      // looks like when the user edits it while still enabled).
      if (scheduleCadenceCanExhaust(validation.value)) return ok({ ...definition, nextRunAt: null })
      return fail('next_run_unavailable', `Unable to compute next run for automation "${definition.id}".`)
    }
    return ok({ ...definition, nextRunAt: new Date(nextRunAt).toISOString() })
  }

  const validation = triggerProvider.validateConfig?.(definition.trigger.config) ?? { ok: true }
  if (!validation.ok) return fail('invalid_trigger_config', validation.error)

  if (definition.status !== 'enabled') {
    return ok({ ...definition, nextRunAt: null })
  }

  if (!triggerProvider.computeNextRun) return ok({ ...definition, nextRunAt: null })

  const nextRunAt = triggerProvider.computeNextRun(definition.trigger.config, after)
  if (nextRunAt === null) {
    return fail('next_run_unavailable', `Unable to compute next run for automation "${definition.id}".`)
  }
  return ok({ ...definition, nextRunAt: new Date(nextRunAt).toISOString() })
}

/**
 * Drop the next run a definition carried in with it, from the file and from the
 * state cache, so the engine computes the schedule from now on its next pass.
 * Approval calls this before it records the yes: a `nextRunAt` the file brought
 * with it may be long past, and the engine fires a past due time at once — the
 * user allowing an automation is not asking for a run this second.
 */
export async function clearCarriedNextRun(
  store: AutomationsStore,
  definition: AutomationDefinition,
): Promise<{ ok: true } | { ok: false; error: AutomationStoreProblem }> {
  if (definition.nextRunAt !== null) {
    const written = await store.updateDefinition({ ...definition, nextRunAt: null })
    if (!written.ok) return written
  }
  return writeNextRunCache(store, definition.id, null)
}

async function writeNextRunCache(
  store: AutomationsStore,
  automationId: string,
  nextRunAt: string | null,
  remove = false,
): Promise<{ ok: true } | { ok: false; error: AutomationStoreProblem }> {
  const stateResult = await store.readState()
  if (!stateResult.ok) return stateResult
  const state = stateResult.value ?? { nextRunAtByAutomationId: {}, lock: null }
  if (remove) {
    delete state.nextRunAtByAutomationId[automationId]
    delete state.triggerEventDedupByAutomationId?.[automationId]
    delete state.triggerBlockedReasonByAutomationId?.[automationId]
  } else {
    state.nextRunAtByAutomationId[automationId] = nextRunAt
  }

  const written = await store.writeState(state)
  if (!written.ok) return written
  return { ok: true }
}

/**
 * The install defaults, applied before the parse so the payload cannot outvote
 * them. A catalogue payload is a template, not a record:
 * - its `id` is the author's and must never become the store id — one project
 *   adding the same starter twice, or two projects adding it, would collide;
 * - it arrives on (owner ruling), so a payload shipping `status: 'paused'` does
 *   not get to land paused;
 * - it never carries `runInWorktree`. A shelf item cannot opt a user out of
 *   run isolation on their behalf (architect ruling, 2026-07-30): without a
 *   worktree an unattended agent runs in the user's own checkout, with no
 *   branch and so no pull request. Dropping the field rather than stamping
 *   `true` leaves `absent ⇒ true` as the single place that answer lives.
 * `cli` and `permissionPreset` are deliberately absent for the same reason:
 * both have live fallbacks (last-selected CLI,
 * `AUTOMATION_DEFAULT_PERMISSION_PRESET`) that stamping here would freeze into
 * a second source of truth.
 *
 * A schedule trigger's `timezone` is resolved to the installing user's own zone
 * here — see `localiseCatalogueSchedule`.
 */
function catalogueDraftInput(payload: unknown, hostTimeZone: string): unknown {
  if (!isRecord(payload)) return payload
  const { id, status, runInWorktree, ...rest } = payload
  return { ...rest, status: 'enabled', trigger: localiseCatalogueSchedule(rest.trigger, hostTimeZone) }
}

/**
 * A catalogue schedule is ALWAYS local: the payload's `timezone` is the
 * author's editing zone, not an instruction, so the install stamps the
 * installing user's own zone over it and the authored wall-clock lands at that
 * time here. "Nightly at 02:00" is 02:00 wherever it is added; before this it
 * was 02:00 UTC, which is mid-afternoon in Sydney (item 2039).
 *
 * One field at one point, deliberately:
 * - `timezone` is already the sole timezone authority for every wall-clock
 *   cadence (`ScheduleTriggerConfig`, shared/automations/contracts.ts), so
 *   `daily`, `weekly` and `at` all move together with nothing cadence-specific
 *   here. `interval` names no wall-clock and is unaffected in behaviour; its
 *   zone is rewritten too rather than special-cased, because a rule that
 *   sometimes leaves the author's zone in place is the thing that drifts.
 *   (`cron` is declared in the contract but rejected by the engine, so no cron
 *   payload reaches a store either way.)
 * - a one-shot `at` is a local wall-clock like the rest, NOT a fixed global
 *   instant. A catalogue payload is a template every reader installs at a
 *   different moment; the author cannot mean one particular instant for all of
 *   them, and the cadence's own contract already says the datetime carries no
 *   `Z`/offset.
 * - so there is no way for a catalogue payload to express a fixed global
 *   instant, by design. A flag for it would be a second timezone authority that
 *   nobody sets.
 *
 * This runs on the install write only. A user's own edit is a normal update
 * through `update()`, which never touches the zone, and no read path
 * re-localises — so an edited cadence stays exactly where the user put it.
 */
function localiseCatalogueSchedule(trigger: unknown, hostTimeZone: string): unknown {
  if (!hostTimeZone || !isRecord(trigger) || trigger.kind !== SCHEDULE_TRIGGER_KIND) return trigger
  if (!isRecord(trigger.config)) return trigger
  return { ...trigger, config: { ...trigger.config, timezone: hostTimeZone } }
}

/**
 * The host's IANA zone, held to the same bar `validateScheduleTriggerConfig`
 * holds the config field to. Empty when the runtime cannot name a usable one:
 * the install then leaves the payload's zone in place rather than stamping a
 * zone the schedule validator would reject, which would refuse an otherwise
 * good starter over the host's clock configuration.
 */
function resolveHostTimeZone(hostTimeZone: DefinitionWriteDeps['hostTimeZone']): string {
  try {
    const zone = (hostTimeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))()
    const trimmed = typeof zone === 'string' ? zone.trim() : ''
    return trimmed && isValidTimeZone(trimmed) ? trimmed : ''
  } catch {
    return ''
  }
}

export function parseDefinitionDraft(input: unknown): AutomationsResult<AutomationDefinitionDraft> {
  if (!isRecord(input)) return fail('invalid_input', 'Automation definition must be an object.')
  const name = trimmedString(input.name)
  if (!name) return fail('invalid_input', 'Automation definition name is required.')
  if (!isAutomationStatus(input.status)) return fail('invalid_input', 'Automation definition status is invalid.')
  const trigger = parseKindConfig(input.trigger, 'trigger')
  if (!trigger.ok) return trigger
  const condition = input.condition === undefined ? ok(undefined) : parseKindConfig(input.condition, 'condition')
  if (!condition.ok) return condition
  const action = parseKindConfig(input.action, 'action')
  if (!action.ok) return action
  // A caller still sending the retired `autonomyDefault` is ignored, not
  // rejected: the field no longer means anything, and failing on it would break
  // agent scripts and module code written against the old draft shape.
  if (input.runInWorktree !== undefined && typeof input.runInWorktree !== 'boolean') {
    return fail('invalid_input', 'Automation definition runInWorktree must be a boolean.')
  }
  const runInWorktree = input.runInWorktree as boolean | undefined
  if (input.disableAfterRun !== undefined && typeof input.disableAfterRun !== 'boolean') {
    return fail('invalid_input', 'Automation definition disableAfterRun must be a boolean.')
  }
  const disableAfterRun = input.disableAfterRun as boolean | undefined
  const id = trimmedString(input.id)
  return ok({
    ...(id ? { id } : {}),
    name,
    status: input.status,
    trigger: trigger.value,
    ...(condition.value ? { condition: condition.value } : {}),
    action: action.value,
    // ownerModuleId and the sourceCatalogueId/sourcePublisher provenance pair
    // are deliberately not read from the input: all three are stamped by the
    // host (module service, marketplace install) or absent (user records) — a
    // caller-supplied owner or provenance is ignored, never trusted.
    ...(runInWorktree === undefined ? {} : { runInWorktree }),
    ...(disableAfterRun === undefined ? {} : { disableAfterRun }),
  })
}

export function parseDefinitionPatch(input: unknown): AutomationsResult<ParsedDefinitionPatch> {
  if (!isRecord(input)) return fail('invalid_input', 'Automation update patch must be an object.')
  const patch: ParsedDefinitionPatch = {}
  if (input.name !== undefined) {
    const name = trimmedString(input.name)
    if (!name) return fail('invalid_input', 'Automation definition name is required.')
    patch.name = name
  }
  if (input.status !== undefined) {
    if (!isAutomationStatus(input.status)) return fail('invalid_input', 'Automation definition status is invalid.')
    patch.status = input.status
  }
  if (input.trigger !== undefined) {
    const trigger = parseKindConfig(input.trigger, 'trigger')
    if (!trigger.ok) return trigger
    patch.trigger = trigger.value
  }
  if (Object.hasOwn(input, 'condition')) {
    if (input.condition === undefined) patch.condition = undefined
    else {
      const condition = parseKindConfig(input.condition, 'condition')
      if (!condition.ok) return condition
      patch.condition = condition.value
    }
  }
  if (input.action !== undefined) {
    const action = parseKindConfig(input.action, 'action')
    if (!action.ok) return action
    patch.action = action.value
  }
  // `autonomyDefault` on a patch is ignored for the same reason it is ignored on
  // a draft: the field is retired, and rejecting it would break existing callers.
  if (input.runInWorktree !== undefined) {
    if (typeof input.runInWorktree !== 'boolean') {
      return fail('invalid_input', 'Automation definition runInWorktree must be a boolean.')
    }
    patch.runInWorktree = input.runInWorktree
  }
  if (input.disableAfterRun !== undefined) {
    if (typeof input.disableAfterRun !== 'boolean') {
      return fail('invalid_input', 'Automation definition disableAfterRun must be a boolean.')
    }
    patch.disableAfterRun = input.disableAfterRun
  }
  return ok(patch)
}

function parseKindConfig(input: unknown, label: string): AutomationsResult<{ kind: string; config: unknown }> {
  if (
    !isRecord(input) ||
    typeof input.kind !== 'string' ||
    input.kind.trim() === '' ||
    !Object.hasOwn(input, 'config')
  ) {
    return fail('invalid_input', `Automation ${label} must include kind and config.`)
  }
  return ok({ kind: input.kind.trim(), config: input.config })
}

export function storeError<T>(error: AutomationStoreProblem): AutomationsResult<T> {
  return fail(error.code, `${error.path}: ${error.message}`)
}

function defaultAutomationId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${slug || 'automation'}-${randomUUID().slice(0, 8)}`
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function isAutomationStatus(value: unknown): value is AutomationDefinition['status'] {
  return typeof value === 'string' && AUTOMATION_STATUSES.has(value)
}

function ok<T>(value: T): AutomationsResult<T> {
  return { ok: true, value }
}

function fail<T = never>(code: string, message: string): AutomationsResult<T> {
  return { ok: false, code, message }
}

/**
 * Provider-declared pairing defaults. A trigger that names `pairsWith` asks the
 * write path to stamp `disableAfterRun` when this draft pairs it with that
 * action and the field is left unspecified. An explicit value — including
 * false — still wins.
 */
export function applyProviderPairDefaults(
  draft: AutomationDefinitionDraft,
  triggerProviders: RegisteredAutomationProvider<AutomationTriggerProvider>[],
): AutomationDefinitionDraft {
  if (draft.disableAfterRun !== undefined) return draft
  const pairing = triggerProviders.find((registration) => registration.kind === draft.trigger.kind)?.provider.pairsWith
  if (!pairing || pairing.actionKind !== draft.action.kind) return draft
  if (pairing.defaultDisableAfterRun !== true) return draft
  return { ...draft, disableAfterRun: true }
}
