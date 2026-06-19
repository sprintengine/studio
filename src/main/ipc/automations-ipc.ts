import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type {
  AutomationActionProvider,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationTriggerProvider,
  AutomationsCreateInput,
  AutomationsDefinitionInput,
  AutomationsDefinitionResult,
  AutomationsDeleteResult,
  AutomationsListResult,
  AutomationsProviderView,
  AutomationsProvidersResult,
  AutomationsResult,
  AutomationsRunNowResult as AutomationsRunNowIpcResult,
  AutomationsRunsListInput,
  AutomationsRunsListResult,
  AutomationsUpdateInput,
} from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import {
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_GET_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_PROVIDERS_LIST_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_RUNS_LIST_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
} from '../../shared/automations/contracts'
import { projectFoldersFromWorkspaceSyncSnapshot, type AutomationsEngine, type AutomationsEngineRunNowResult } from '../automations/engine'
import {
  allowAutomationProvider,
  automationProviderBlockedReason,
  type AutomationProviderPermissionChecker,
  type RegisteredAutomationProvider,
} from '../automations/provider-registry'
import { computeNextRun, validateScheduleTriggerConfig } from '../automations/schedule'
import { AutomationsStore, type AutomationStoreProblem } from '../automations/store'
import type { IpcInvokeHandler } from '../module-host/main-host'

export type AutomationsIpcHost = {
  registerIpc(channel: string, handler: IpcInvokeHandler): void
}

export type AutomationsIpcDependencies = {
  engine: Pick<AutomationsEngine, 'runNow'>
  createStore?: (workspaceRoot: string) => AutomationsStore
  triggerProviders?: AutomationTriggerProvider[]
  actionProviders?: AutomationActionProvider[]
  triggerProviderRegistrations?: RegisteredAutomationProvider<AutomationTriggerProvider>[]
  actionProviderRegistrations?: RegisteredAutomationProvider<AutomationActionProvider>[]
  getTriggerProviders?: () => AutomationTriggerProvider[]
  getActionProviders?: () => AutomationActionProvider[]
  getTriggerProviderRegistrations?: () => RegisteredAutomationProvider<AutomationTriggerProvider>[]
  getActionProviderRegistrations?: () => RegisteredAutomationProvider<AutomationActionProvider>[]
  checkProviderPermission?: AutomationProviderPermissionChecker
  isIntegrationAvailable?: (id: string) => boolean | undefined
  getWorkspaceSyncSnapshot?: () => WorkspaceSyncSnapshot
  onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>
  now?: () => number
  createAutomationId?: (draft: AutomationDefinitionDraft) => string
}

type ParsedDefinitionPatch = Partial<Pick<
  AutomationDefinition,
  'name' | 'status' | 'trigger' | 'condition' | 'action' | 'autonomyDefault'
>>

const AUTOMATION_STATUSES = new Set(['enabled', 'paused', 'blocked'])
const AUTONOMY_DEFAULTS = new Set(['review_only', 'allow_changes'])

export function registerAutomationsIpc(host: AutomationsIpcHost, deps: AutomationsIpcDependencies): void {
  const createStore = deps.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot))
  const staticTriggerProviders = deps.triggerProviders ?? []
  const staticActionProviders = deps.actionProviders ?? []
  const getTriggerProviders = deps.getTriggerProviders ?? (() => staticTriggerProviders)
  const getActionProviders = deps.getActionProviders ?? (() => staticActionProviders)
  const getTriggerProviderRegistrations = deps.getTriggerProviderRegistrations
    ?? (() => deps.triggerProviderRegistrations ?? getTriggerProviders().map((provider) =>
      legacyProviderRegistration('trigger', provider)
    ))
  const getActionProviderRegistrations = deps.getActionProviderRegistrations
    ?? (() => deps.actionProviderRegistrations ?? getActionProviders().map((provider) =>
      legacyProviderRegistration('action', provider)
    ))
  const checkProviderPermission = deps.checkProviderPermission ?? allowAutomationProvider
  const now = deps.now ?? Date.now

  host.registerIpc(AUTOMATIONS_LIST_CHANNEL, async (_event, input: unknown): Promise<AutomationsListResult> => {
    const workspaceRoot = parseWorkspaceRoot(input, deps.getWorkspaceSyncSnapshot)
    if (!workspaceRoot.ok) return workspaceRoot
    const definitions = await createStore(workspaceRoot.value).listDefinitions()
    if (!definitions.ok) return storeErrors(definitions.errors)
    return ok(definitions.values)
  })

  host.registerIpc(AUTOMATIONS_GET_CHANNEL, async (_event, input: unknown): Promise<AutomationsDefinitionResult> => {
    const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed
    const definition = await createStore(parsed.value.workspaceRoot).getDefinition(parsed.value.automationId)
    if (!definition.ok) return storeError(definition.error)
    return ok(definition.value)
  })

  host.registerIpc(AUTOMATIONS_CREATE_CHANNEL, async (_event, input: unknown): Promise<AutomationsDefinitionResult> => {
    const parsed = parseCreateInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed

    const timestamp = new Date(now()).toISOString()
    const definition = buildDefinitionForCreate(parsed.value.definition, timestamp, deps.createAutomationId)
    const prepared = prepareDefinitionForWrite(
      definition,
      getTriggerProviderRegistrations(),
      getActionProviderRegistrations(),
      checkProviderPermission,
      now()
    )
    if (!prepared.ok) return prepared

    const store = createStore(parsed.value.workspaceRoot)
    const created = await store.createDefinition(prepared.value)
    if (!created.ok) return storeError(created.error)
    const state = await writeNextRunCache(store, prepared.value.id, prepared.value.nextRunAt)
    if (!state.ok) return storeError(state.error)
    const notified = await notifyDefinitionsChanged(deps, parsed.value.workspaceRoot)
    if (!notified.ok) return notified
    return ok(created.value)
  })

  host.registerIpc(AUTOMATIONS_UPDATE_CHANNEL, async (_event, input: unknown): Promise<AutomationsDefinitionResult> => {
    const parsed = parseUpdateInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed

    const store = createStore(parsed.value.workspaceRoot)
    const existing = await store.getDefinition(parsed.value.automationId)
    if (!existing.ok) return storeError(existing.error)

    const timestamp = new Date(now()).toISOString()
    const updated: AutomationDefinition = {
      ...existing.value,
      ...parsed.value.patch,
      id: existing.value.id,
      createdAt: existing.value.createdAt,
      updatedAt: timestamp,
    }
    const prepared = prepareDefinitionForWrite(
      updated,
      getTriggerProviderRegistrations(),
      getActionProviderRegistrations(),
      checkProviderPermission,
      now()
    )
    if (!prepared.ok) return prepared

    const written = await store.updateDefinition(prepared.value)
    if (!written.ok) return storeError(written.error)
    const state = await writeNextRunCache(store, prepared.value.id, prepared.value.nextRunAt)
    if (!state.ok) return storeError(state.error)
    const notified = await notifyDefinitionsChanged(deps, parsed.value.workspaceRoot)
    if (!notified.ok) return notified
    return ok(written.value)
  })

  host.registerIpc(AUTOMATIONS_DELETE_CHANNEL, async (_event, input: unknown): Promise<AutomationsDeleteResult> => {
    const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed

    const store = createStore(parsed.value.workspaceRoot)
    const deleted = await store.deleteDefinition(parsed.value.automationId)
    if (!deleted.ok) return storeError(deleted.error)
    const state = await writeNextRunCache(store, parsed.value.automationId, null, true)
    if (!state.ok) return storeError(state.error)
    const notified = await notifyDefinitionsChanged(deps, parsed.value.workspaceRoot)
    if (!notified.ok) return notified
    return ok({ automationId: parsed.value.automationId })
  })

  host.registerIpc(AUTOMATIONS_RUN_NOW_CHANNEL, async (_event, input: unknown): Promise<AutomationsRunNowIpcResult> => {
    const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed
    const result = await deps.engine.runNow(parsed.value)
    return engineRunNowResult(result)
  })

  host.registerIpc(AUTOMATIONS_RUNS_LIST_CHANNEL, async (_event, input: unknown): Promise<AutomationsRunsListResult> => {
    const parsed = parseRunsListInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed
    const runs = await createStore(parsed.value.workspaceRoot).listRuns(parsed.value.automationId)
    if (!runs.ok) return storeErrors(runs.errors)
    return ok(runs.values)
  })

  host.registerIpc(AUTOMATIONS_PROVIDERS_LIST_CHANNEL, async (): Promise<AutomationsProvidersResult> => {
    return ok({
      triggers: getTriggerProviderRegistrations().map((registration) =>
        providerView(registration, deps.isIntegrationAvailable, checkProviderPermission)
      ),
      actions: getActionProviderRegistrations().map((registration) =>
        providerView(registration, deps.isIntegrationAvailable, checkProviderPermission)
      ),
    })
  })
}

function buildDefinitionForCreate(
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
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function prepareDefinitionForWrite(
  definition: AutomationDefinition,
  triggerProviders: RegisteredAutomationProvider<AutomationTriggerProvider>[],
  actionProviders: RegisteredAutomationProvider<AutomationActionProvider>[],
  checkProviderPermission: AutomationProviderPermissionChecker,
  after: number
): AutomationsDefinitionResult {
  const triggerRegistration = triggerProviders.find((registration) => registration.provider.kind === definition.trigger.kind)
  if (!triggerRegistration) {
    return fail('unknown_trigger', `No automation trigger provider is registered for "${definition.trigger.kind}".`)
  }
  const triggerBlockedReason = automationProviderBlockedReason(
    triggerRegistration,
    checkProviderPermission(triggerRegistration)
  )
  if (triggerBlockedReason) return fail('provider_blocked', triggerBlockedReason)

  const actionRegistration = actionProviders.find((registration) => registration.provider.kind === definition.action.kind)
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

function providerView(
  registration: RegisteredAutomationProvider<AutomationTriggerProvider | AutomationActionProvider>,
  isIntegrationAvailable: ((id: string) => boolean | undefined) | undefined,
  checkProviderPermission: AutomationProviderPermissionChecker
): AutomationsProviderView {
  const provider = registration.provider
  const requiredIntegrations = 'requiredIntegrations' in provider ? provider.requiredIntegrations ?? [] : []
  const blockedReason = automationProviderBlockedReason(registration, checkProviderPermission(registration))
  return {
    kind: provider.kind,
    configSchema: provider.configSchema,
    requiredIntegrations,
    missingIntegrations: requiredIntegrations.filter((id) => isIntegrationAvailable?.(id) !== true),
    ...(blockedReason ? { blockedReason } : {}),
  }
}

function legacyProviderRegistration<T extends AutomationTriggerProvider | AutomationActionProvider>(
  providerType: T extends AutomationTriggerProvider ? 'trigger' : 'action',
  provider: T
): RegisteredAutomationProvider<T> {
  return {
    providerId: provider.kind,
    moduleId: 'automations',
    providerType,
    provider,
  } as RegisteredAutomationProvider<T>
}

function parseWorkspaceRoot(
  input: unknown,
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined
): AutomationsResult<string> {
  if (!isRecord(input) || typeof input.workspaceRoot !== 'string' || input.workspaceRoot.trim() === '') {
    return fail('invalid_input', 'workspaceRoot is required.')
  }
  const workspaceRoot = input.workspaceRoot.trim()
  const trustedRoot = validateKnownWorkspaceRoot(workspaceRoot, getWorkspaceSyncSnapshot)
  if (!trustedRoot.ok) return trustedRoot
  return ok(trustedRoot.value)
}

function parseDefinitionInput(
  input: unknown,
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined
): AutomationsResult<AutomationsDefinitionInput> {
  const workspaceRoot = parseWorkspaceRoot(input, getWorkspaceSyncSnapshot)
  if (!workspaceRoot.ok) return workspaceRoot
  if (!isRecord(input) || typeof input.automationId !== 'string' || input.automationId.trim() === '') {
    return fail('invalid_input', 'automationId is required.')
  }
  const workspaceId = trimmedString(input.workspaceId)
  return ok({
    workspaceRoot: workspaceRoot.value,
    ...(workspaceId ? { workspaceId } : {}),
    automationId: input.automationId.trim(),
  })
}

function parseCreateInput(
  input: unknown,
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined
): AutomationsResult<AutomationsCreateInput> {
  const workspaceRoot = parseWorkspaceRoot(input, getWorkspaceSyncSnapshot)
  if (!workspaceRoot.ok) return workspaceRoot
  if (!isRecord(input)) return fail('invalid_input', 'Automation create input must be an object.')
  const definition = parseDefinitionDraft(input.definition)
  if (!definition.ok) return definition
  return ok({ workspaceRoot: workspaceRoot.value, definition: definition.value })
}

function parseUpdateInput(
  input: unknown,
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined
): AutomationsResult<AutomationsUpdateInput & { patch: ParsedDefinitionPatch }> {
  const base = parseDefinitionInput(input, getWorkspaceSyncSnapshot)
  if (!base.ok) return base
  if (!isRecord(input)) return fail('invalid_input', 'Automation update input must be an object.')
  const patch = parseDefinitionPatch(input.patch)
  if (!patch.ok) return patch
  return ok({ ...base.value, patch: patch.value })
}

function parseRunsListInput(
  input: unknown,
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined
): AutomationsResult<AutomationsRunsListInput> {
  return parseDefinitionInput(input, getWorkspaceSyncSnapshot)
}

function validateKnownWorkspaceRoot(
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

function parseDefinitionDraft(input: unknown): AutomationsResult<AutomationDefinitionDraft> {
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
  const id = trimmedString(input.id)
  return ok({
    ...(id ? { id } : {}),
    name,
    status: input.status,
    trigger: trigger.value,
    ...(condition.value ? { condition: condition.value } : {}),
    action: action.value,
    autonomyDefault: input.autonomyDefault,
  })
}

function parseDefinitionPatch(input: unknown): AutomationsResult<ParsedDefinitionPatch> {
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
  return ok(patch)
}

function parseKindConfig(input: unknown, label: string): AutomationsResult<{ kind: string; config: unknown }> {
  if (!isRecord(input) || typeof input.kind !== 'string' || input.kind.trim() === '' || !Object.hasOwn(input, 'config')) {
    return fail('invalid_input', `Automation ${label} must include kind and config.`)
  }
  return ok({ kind: input.kind.trim(), config: input.config })
}

function engineRunNowResult(result: AutomationsEngineRunNowResult): AutomationsRunNowIpcResult {
  if (result.ok) return ok({ definition: result.definition, run: result.run })
  return fail(result.problem.code, result.problem.message)
}

async function notifyDefinitionsChanged(
  deps: AutomationsIpcDependencies,
  workspaceRoot: string
): Promise<AutomationsResult<void>> {
  try {
    await deps.onDefinitionsChanged?.(workspaceRoot)
    return ok(undefined)
  } catch (error) {
    return fail(
      'webhook_receiver_refresh_failed',
      error instanceof Error ? error.message : 'Webhook receiver refresh failed.'
    )
  }
}

function storeError<T>(error: AutomationStoreProblem): AutomationsResult<T> {
  return fail(error.code, `${error.path}: ${error.message}`)
}

function storeErrors<T>(errors: AutomationStoreProblem[]): AutomationsResult<T> {
  const [first] = errors
  if (!first) return fail('store_error', 'Automations store operation failed.')
  if (errors.length === 1) return storeError(first)
  return fail('store_error', `${errors.length} automations store files are malformed or unreadable.`)
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
