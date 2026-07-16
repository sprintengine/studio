import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type {
  AutomationActionProvider,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationTriggerProvider,
  AutomationsResult,
} from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { projectFoldersFromWorkspaceSyncSnapshot } from './engine'
import {
  automationProviderBlockedReason,
  type AutomationProviderPermissionChecker,
  type RegisteredAutomationProvider,
} from './provider-registry'
import { computeNextRun, scheduleCadenceCanExhaust, validateScheduleTriggerConfig } from './schedule'
import { AutomationsStore, type AutomationStoreProblem } from './store'

// The one write path for automation definitions. Both front doors — the
// user-facing IPC handlers (automations-ipc.ts) and the module-scoped service
// (module-service.ts) — route create/update/delete through this core, so
// draft/patch validation, provider + schedule validation, `nextRunAt`
// computation, the next-run state cache, and the definitions-changed
// notification (webhook receiver refresh) cannot drift between callers.

export type ParsedDefinitionPatch = Partial<Pick<
  AutomationDefinition,
  'name' | 'status' | 'trigger' | 'condition' | 'action' | 'autonomyDefault' | 'runInWorktree' | 'disableAfterRun'
>>

const AUTOMATION_STATUSES = new Set(['enabled', 'paused', 'blocked'])
const AUTONOMY_DEFAULTS = new Set(['review_only', 'allow_changes'])

export type DefinitionWriteDeps = {
  createStore: (workspaceRoot: string) => AutomationsStore
  getTriggerProviderRegistrations: () => RegisteredAutomationProvider<AutomationTriggerProvider>[]
  getActionProviderRegistrations: () => RegisteredAutomationProvider<AutomationActionProvider>[]
  checkProviderPermission: AutomationProviderPermissionChecker
  now: () => number
  createAutomationId?: (draft: AutomationDefinitionDraft) => string
  /**
   * Post-write hook (e.g. webhook receiver refresh, renderer notification). A
   * throw never fails the operation — the write already persisted — it is
   * surfaced as `postWriteFailure` on the success result for each front door
   * to report in its own vocabulary.
   */
  onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>
}

export type PostWriteFailure = { code: string; message: string }

export type DefinitionWriteResult<T> =
  | { ok: true; value: T; postWriteFailure?: PostWriteFailure }
  | { ok: false; code: string; message: string }

/**
 * Evaluated against the record read inside the same read→write sequence, so a
 * caller's guard (e.g. module ownership) cannot be split from the write by a
 * concurrent delete-and-recreate between two separate reads.
 */
export type DefinitionPrecondition = (
  existing: AutomationDefinition
) => { ok: true } | { ok: false; code: string; message: string }

export type DefinitionWriteCore = {
  get(workspaceRoot: string, automationId: string): Promise<DefinitionWriteResult<AutomationDefinition>>
  create(
    workspaceRoot: string,
    draft: AutomationDefinitionDraft
  ): Promise<DefinitionWriteResult<AutomationDefinition>>
  update(
    workspaceRoot: string,
    automationId: string,
    patch: ParsedDefinitionPatch,
    precondition?: DefinitionPrecondition
  ): Promise<DefinitionWriteResult<AutomationDefinition>>
  remove(
    workspaceRoot: string,
    automationId: string,
    precondition?: DefinitionPrecondition
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

  async function finishWrite<T>(workspaceRoot: string, value: T): Promise<DefinitionWriteResult<T>> {
    const postWriteFailure = await notifyDefinitionsChanged(workspaceRoot)
    return postWriteFailure ? { ok: true, value, postWriteFailure } : { ok: true, value }
  }

  return {
    async get(workspaceRoot, automationId) {
      const definition = await deps.createStore(workspaceRoot).getDefinition(automationId)
      if (!definition.ok) return storeError(definition.error)
      return { ok: true, value: definition.value }
    },

    async create(workspaceRoot, draft) {
      const timestamp = new Date(deps.now()).toISOString()
      const definition = buildDefinitionForCreate(draft, timestamp, deps.createAutomationId)
      const prepared = prepareDefinitionForWrite(
        definition,
        deps.getTriggerProviderRegistrations(),
        deps.getActionProviderRegistrations(),
        deps.checkProviderPermission,
        deps.now()
      )
      if (!prepared.ok) return prepared

      const store = deps.createStore(workspaceRoot)
      const created = await store.createDefinition(prepared.value)
      if (!created.ok) return storeError(created.error)
      const state = await writeNextRunCache(store, prepared.value.id, prepared.value.nextRunAt)
      if (!state.ok) return storeError(state.error)
      return finishWrite(workspaceRoot, created.value)
    },

    async update(workspaceRoot, automationId, patch, precondition) {
      const store = deps.createStore(workspaceRoot)
      const existing = await store.getDefinition(automationId)
      if (!existing.ok) return storeError(existing.error)
      const admitted = precondition?.(existing.value) ?? { ok: true as const }
      if (!admitted.ok) return admitted

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
        deps.now()
      )
      if (!prepared.ok) return prepared

      const written = await store.updateDefinition(prepared.value)
      if (!written.ok) return storeError(written.error)
      const state = await writeNextRunCache(store, prepared.value.id, prepared.value.nextRunAt)
      if (!state.ok) return storeError(state.error)
      return finishWrite(workspaceRoot, written.value)
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
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined
): AutomationsResult<string> {
  if (!isAbsolute(workspaceRoot)) {
    return fail('invalid_input', 'workspaceRoot must be an absolute path.')
  }
  if (!getWorkspaceSyncSnapshot) {
    return fail('workspace_root_unverified', 'workspaceRoot cannot be verified against the workspace snapshot.')
  }

  try {
    const workspaceRootKey = normalizeWorkspaceRoot(workspaceRoot)
    const knownFolder = projectFoldersFromWorkspaceSyncSnapshot(getWorkspaceSyncSnapshot())
      .find((folder) => normalizeWorkspaceRoot(folder.folderPath) === workspaceRootKey)
    if (!knownFolder) {
      return fail('workspace_root_untrusted', 'workspaceRoot must match an open workspace folder.')
    }
    return ok(knownFolder.folderPath.trim())
  } catch (error) {
    return fail(
      'workspace_snapshot_unavailable',
      error instanceof Error ? error.message : 'Unable to verify workspaceRoot against the workspace snapshot.'
    )
  }
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

export function buildDefinitionForCreate(
  draft: AutomationDefinitionDraft,
  timestamp: string,
  createAutomationId?: (draft: AutomationDefinitionDraft) => string
): AutomationDefinition {
  return {
    id: (draft.id?.trim() || createAutomationId?.(draft) || defaultAutomationId(draft.name)),
    name: draft.name.trim(),
    status: draft.status,
    trigger: draft.trigger,
    condition: draft.condition,
    action: draft.action,
    autonomyDefault: draft.autonomyDefault,
    ...(draft.runInWorktree === undefined ? {} : { runInWorktree: draft.runInWorktree }),
    ...(draft.disableAfterRun === undefined ? {} : { disableAfterRun: draft.disableAfterRun }),
    ...(draft.ownerModuleId === undefined ? {} : { ownerModuleId: draft.ownerModuleId }),
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
  after: number
): AutomationsResult<AutomationDefinition> {
  const triggerRegistration = triggerProviders.find((registration) => registration.kind === definition.trigger.kind)
  if (!triggerRegistration) {
    return fail('unknown_trigger', `No automation trigger provider is registered for "${definition.trigger.kind}".`)
  }
  const triggerBlockedReason = automationProviderBlockedReason(
    triggerRegistration,
    checkProviderPermission(triggerRegistration)
  )
  if (triggerBlockedReason) return fail('provider_blocked', triggerBlockedReason)

  const actionRegistration = actionProviders.find((registration) => registration.kind === definition.action.kind)
  if (!actionRegistration) {
    return fail('unknown_action', `No automation action provider is registered for "${definition.action.kind}".`)
  }
  const actionBlockedReason = automationProviderBlockedReason(
    actionRegistration,
    checkProviderPermission(actionRegistration)
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

async function writeNextRunCache(
  store: AutomationsStore,
  automationId: string,
  nextRunAt: string | null,
  remove = false
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
  if (!isAutonomyDefault(input.autonomyDefault)) {
    return fail('invalid_input', 'Automation definition autonomyDefault is invalid.')
  }
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
    autonomyDefault: input.autonomyDefault,
    // ownerModuleId is deliberately not read from the input: ownership is
    // stamped by the host (module service) or absent (user records) — a
    // caller-supplied owner is ignored, never trusted.
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
  if (input.autonomyDefault !== undefined) {
    if (!isAutonomyDefault(input.autonomyDefault)) {
      return fail('invalid_input', 'Automation definition autonomyDefault is invalid.')
    }
    patch.autonomyDefault = input.autonomyDefault
  }
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

export function parseKindConfig(input: unknown, label: string): AutomationsResult<{ kind: string; config: unknown }> {
  if (!isRecord(input) || typeof input.kind !== 'string' || input.kind.trim() === '' || !Object.hasOwn(input, 'config')) {
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

function isAutonomyDefault(value: unknown): value is AutomationDefinition['autonomyDefault'] {
  return typeof value === 'string' && AUTONOMY_DEFAULTS.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ok<T>(value: T): AutomationsResult<T> {
  return { ok: true, value }
}

function fail<T = never>(code: string, message: string): AutomationsResult<T> {
  return { ok: false, code, message }
}
