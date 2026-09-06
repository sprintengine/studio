import type {
  AutomationActionProvider,
  AutomationDefinition,
  AutomationsBuiltinListResult,
  AutomationsBuiltinInstallResult,
  AutomationDefinitionDraft,
  AutomationTriggerProvider,
  AutomationsCreateInput,
  AutomationsDefinitionInput,
  AutomationsDefinitionResult,
  AutomationsDeleteResult,
  AutomationsEngineStatusResult,
  AutomationsInstanceListResult,
  AutomationsListResult,
  AutomationsProviderView,
  AutomationsProvidersResult,
  AutomationsResult,
  AutomationsRunNowResult as AutomationsRunNowIpcResult,
  AutomationsRunFinalizeInput,
  AutomationsRunFinalizeResult,
  AutomationsRunsListInput,
  AutomationsRunsListResult,
  AutomationsUpdateInput,
} from '../../shared/automations/contracts'
import {
  BUILTIN_AUTOMATIONS,
  builtinAutomationById,
  builtinAutomationPayload,
} from '../../shared/automations/builtin'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import {
  AUTOMATIONS_BUILTIN_INSTALL_CHANNEL,
  AUTOMATIONS_BUILTIN_LIST_CHANNEL,
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_ENGINE_STATUS_CHANNEL,
  AUTOMATIONS_GET_CHANNEL,
  AUTOMATIONS_INSTANCE_LIST_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_PROVIDERS_LIST_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_RUN_FINALIZE_CHANNEL,
  AUTOMATIONS_RUNS_LIST_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
} from '../../shared/automations/contracts'
import {
  createDefinitionWriteCore,
  parseDefinitionDraft,
  parseDefinitionPatch,
  storeError,
  validateKnownWorkspaceRoot,
  type DefinitionWriteResult,
  type ParsedDefinitionPatch,
} from '../automations/definition-write'
import {
  buildAutomationsInstanceIndex,
  type AutomationsInstanceProjectFolder,
} from '../automations/instance-index'
import {
  projectFoldersFromWorkspaceSyncSnapshot,
  type AutomationsEngine,
  type AutomationsEngineFinalizeResult,
  type AutomationsEngineRunNowResult,
} from '../automations/engine'
import {
  allowAutomationProvider,
  automationProviderBlockedReason,
  type AutomationProviderPermissionChecker,
  type RegisteredAutomationProvider,
} from '../automations/provider-registry'
import { AutomationsStore, type AutomationStoreProblem } from '../automations/store'
import { WEBHOOK_TRIGGER_KIND } from '../automations/triggers/webhook'
import type { IpcInvokeHandler, SidecarRuntimeStatus } from '../module-host/main-host'

export type AutomationsIpcHost = {
  registerIpc(channel: string, handler: IpcInvokeHandler): void
}

export type AutomationsIpcDependencies = {
  engine: Pick<AutomationsEngine, 'runNow' | 'finalizeRun'>
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
  /**
   * Known project roots the instance-wide index scans. Defaults to deriving them
   * from the workspace-sync snapshot (every open workspace's folder, deduped) —
   * the same source the engine and webhook receiver use — so the module normally
   * omits it.
   */
  getProjectFolders?: () => AutomationsInstanceProjectFolder[]
  /**
   * Reads the kernel-tracked status of the Automations engine/scheduler sidecar
   * (kernel.sidecarStatuses() filtered to this module's sidecar, via the handle
   * registerSidecar returns). Absent/undefined means the sidecar is not wired,
   * which the engine-status channel reports as 'unavailable'.
   */
  getEngineSidecarStatus?: () => SidecarRuntimeStatus | undefined
  onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>
  now?: () => number
  createAutomationId?: (draft: AutomationDefinitionDraft) => string
}

export function registerAutomationsIpc(host: AutomationsIpcHost, deps: AutomationsIpcDependencies): AutomationsAppFrontDoor {
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
  // Shared with the module-scoped Automations service: one write core, two
  // front doors (see definition-write.ts).
  const writeCore = createDefinitionWriteCore({
    createStore,
    getTriggerProviderRegistrations,
    getActionProviderRegistrations,
    checkProviderPermission,
    now,
    createAutomationId: deps.createAutomationId,
    onDefinitionsChanged: deps.onDefinitionsChanged,
  })

  host.registerIpc(AUTOMATIONS_LIST_CHANNEL, async (_event, input: unknown): Promise<AutomationsListResult> => {
    const workspaceRoot = parseWorkspaceRoot(input, deps.getWorkspaceSyncSnapshot)
    if (!workspaceRoot.ok) return workspaceRoot
    const definitions = await createStore(workspaceRoot.value).listDefinitions()
    if (!definitions.ok) return storeErrors(definitions.errors)
    return ok(definitions.values.map(definitionForRenderer))
  })

  host.registerIpc(AUTOMATIONS_GET_CHANNEL, async (_event, input: unknown): Promise<AutomationsDefinitionResult> => {
    const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed
    const definition = await writeCore.get(parsed.value.workspaceRoot, parsed.value.automationId)
    if (!definition.ok) return definition
    return ok(definitionForRenderer(definition.value))
  })

  // Shared by the IPC channel and the app-level front door (automation server
  // tools): one parse+write pipeline, so external creates get the identical
  // validation, ownership stamping, and post-write refresh.
  const createDefinition = async (input: unknown): Promise<AutomationsDefinitionResult> => {
    const parsed = parseCreateInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed

    const created = withPostWriteFailure(await writeCore.create(parsed.value.workspaceRoot, parsed.value.definition))
    if (!created.ok) return created
    return ok(definitionForRenderer(created.value))
  }

  // The marketplace install path (no IPC channel of its own — the marketplace's
  // own install handler calls this). Same workspace-root trust gate as every
  // other write, so a shelf install can only ever land in a project the app has
  // open: an install with no target refuses rather than picking one.
  const installCatalogueDefinition = async (input: unknown): Promise<AutomationsCatalogueInstallResult> => {
    const workspaceRoot = parseWorkspaceRoot(input, deps.getWorkspaceSyncSnapshot)
    if (!workspaceRoot.ok) return workspaceRoot
    if (!isRecord(input) || typeof input.sourceCatalogueId !== 'string') {
      return fail('invalid_input', 'sourceCatalogueId is required.')
    }
    const sourcePublisher = trimmedString(input.sourcePublisher)
    const installed = withPostWriteFailure(await writeCore.installFromCatalogue(workspaceRoot.value, {
      payload: input.definition,
      sourceCatalogueId: input.sourceCatalogueId,
      ...(sourcePublisher ? { sourcePublisher } : {}),
    }))
    if (!installed.ok) return installed
    return ok({
      definition: definitionForRenderer(installed.value.definition),
      alreadyAdded: installed.value.alreadyAdded,
      workspaceRoot: workspaceRoot.value,
    })
  }

  const runNow = async (input: unknown): Promise<AutomationsRunNowIpcResult> => {
    const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed
    const result = await deps.engine.runNow(parsed.value)
    return engineRunNowResult(result)
  }

  // Shared by the update channel and the app-level front door, exactly as
  // createDefinition is: the mobile `automations.control` command enables and
  // pauses through this, so the phone's write gets the identical patch parse,
  // provider validation, next-run recompute and post-write refresh the desktop
  // UI's own toggle gets — rather than a second write path onto the same store.
  const updateDefinition = async (input: unknown): Promise<AutomationsDefinitionResult> => {
    const parsed = parseUpdateInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed

    const written = withPostWriteFailure(await writeCore.update(
      parsed.value.workspaceRoot,
      parsed.value.automationId,
      parsed.value.patch
    ))
    if (!written.ok) return written
    return ok(definitionForRenderer(written.value))
  }

  host.registerIpc(AUTOMATIONS_CREATE_CHANNEL, async (_event, input: unknown): Promise<AutomationsDefinitionResult> => {
    return createDefinition(input)
  })

  host.registerIpc(AUTOMATIONS_UPDATE_CHANNEL, async (_event, input: unknown): Promise<AutomationsDefinitionResult> => {
    return updateDefinition(input)
  })

  host.registerIpc(AUTOMATIONS_DELETE_CHANNEL, async (_event, input: unknown): Promise<AutomationsDeleteResult> => {
    const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed

    const deleted = withPostWriteFailure(await writeCore.remove(parsed.value.workspaceRoot, parsed.value.automationId))
    if (!deleted.ok) return deleted
    return ok(deleted.value)
  })

  host.registerIpc(AUTOMATIONS_RUN_NOW_CHANNEL, async (_event, input: unknown): Promise<AutomationsRunNowIpcResult> => {
    return runNow(input)
  })

  host.registerIpc(AUTOMATIONS_RUN_FINALIZE_CHANNEL, async (_event, input: unknown): Promise<AutomationsRunFinalizeResult> => {
    const parsed = parseRunFinalizeInput(input, deps.getWorkspaceSyncSnapshot)
    if (!parsed.ok) return parsed
    const result = await deps.engine.finalizeRun(parsed.value)
    return engineFinalizeResult(result)
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

  host.registerIpc(AUTOMATIONS_INSTANCE_LIST_CHANNEL, async (): Promise<AutomationsInstanceListResult> => {
    const snapshot = deps.getWorkspaceSyncSnapshot?.()
    const projectFolders = deps.getProjectFolders?.()
      ?? (snapshot ? projectFoldersFromWorkspaceSyncSnapshot(snapshot) : [])
    const index = await buildAutomationsInstanceIndex({
      projectFolders,
      createStore,
      // Redact webhook secrets on the way out, exactly as the per-project list.
      mapDefinition: definitionForRenderer,
    })
    return ok(index)
  })

  // The five automations that ship inside the app (Extensions drawer ruling,
  // 2026-09-05, frame 4). Main answers rather than the renderer importing the
  // module directly, because main is where "what ships" is decided: when a build
  // one day reads them from disk or from a signed pack, only this handler moves.
  host.registerIpc(AUTOMATIONS_BUILTIN_LIST_CHANNEL, async (): Promise<AutomationsBuiltinListResult> => {
    return ok([...BUILTIN_AUTOMATIONS])
  })

  // "Add to <project>" — the SAME write the marketplace shelf's Get performed,
  // reached by naming a built-in instead of carrying a payload: the renderer
  // never hands over a definition, so nothing it could tamper with decides what
  // is written. `installFromCatalogue` keys on the built-in's stable id, so a
  // project that already has this one (including a copy the old Plugins shelf
  // added, which recorded the same id) is reported as already added rather than
  // gaining a duplicate.
  host.registerIpc(AUTOMATIONS_BUILTIN_INSTALL_CHANNEL, async (_event, input: unknown): Promise<AutomationsBuiltinInstallResult> => {
    if (!isRecord(input) || typeof input.builtinId !== 'string') {
      return fail('invalid_input', 'builtinId is required.')
    }
    const builtin = builtinAutomationById(input.builtinId.trim())
    if (!builtin) return fail('not_found', 'That automation does not ship with this version of the app.')
    return installCatalogueDefinition({
      workspaceRoot: input.workspaceRoot,
      definition: builtinAutomationPayload(builtin),
      sourceCatalogueId: builtin.id,
      sourcePublisher: builtin.publisher,
    })
  })

  host.registerIpc(AUTOMATIONS_ENGINE_STATUS_CHANNEL, async (): Promise<AutomationsEngineStatusResult> => {
    const status = deps.getEngineSidecarStatus?.()
    if (!status) return ok({ state: 'unavailable' })
    return ok({ state: status.state, ...(status.error ? { error: status.error } : {}) })
  })

  return { createDefinition, updateDefinition, installCatalogueDefinition, runNow }
}

/**
 * What a marketplace install landed: the definition (existing one when the
 * project already had this catalogue entry) and the project it lives in, so the
 * caller can name the target it used rather than leaving the user to guess.
 */
export type AutomationsCatalogueInstall = {
  definition: AutomationDefinition
  alreadyAdded: boolean
  workspaceRoot: string
}

export type AutomationsCatalogueInstallResult = AutomationsResult<AutomationsCatalogueInstall>

// App-level front door over the exact IPC pipeline (parse, workspace-root
// trust, write core, engine). The automations module provides it as a kernel
// service so the automation server's tools — and the phone's
// `automations.control` command — mutate through the same path the UI does;
// inputs stay `unknown` because the pipeline owns validation.
export type AutomationsAppFrontDoor = {
  createDefinition(input: unknown): Promise<AutomationsDefinitionResult>
  updateDefinition(input: unknown): Promise<AutomationsDefinitionResult>
  /**
   * Adds a marketplace catalogue entry's automation to a project. The
   * marketplace install path reaches the automations store only through here —
   * there is no file for it to copy, so this is its equivalent of the
   * `.agents/<kind>/` unpack every other component kind does.
   */
  installCatalogueDefinition(input: unknown): Promise<AutomationsCatalogueInstallResult>
  runNow(input: unknown): Promise<AutomationsRunNowIpcResult>
}

function providerView(
  registration: RegisteredAutomationProvider<AutomationTriggerProvider | AutomationActionProvider>,
  isIntegrationAvailable: ((id: string) => boolean | undefined) | undefined,
  checkProviderPermission: AutomationProviderPermissionChecker
): AutomationsProviderView {
  const blockedReason = automationProviderBlockedReason(registration, checkProviderPermission(registration))
  const requiredIntegrations = registration.requiredIntegrations
  return {
    kind: registration.kind,
    configSchema: registration.configSchema,
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
    kind: provider.kind,
    configSchema: ownDataProperty(provider, 'configSchema', fallbackConfigSchema()),
    requiredIntegrations: snapshotRequiredIntegrations(provider),
    provider,
  } as RegisteredAutomationProvider<T>
}

function definitionForRenderer(definition: AutomationDefinition): AutomationDefinition {
  const config = definition.trigger.config
  if (definition.trigger.kind !== WEBHOOK_TRIGGER_KIND || !isRecord(config)) return definition
  const { secret, ...redactedConfig } = config
  return {
    ...definition,
    trigger: {
      ...definition.trigger,
      config: {
        ...redactedConfig,
        hasSecret: typeof secret === 'string' && secret.trim().length > 0,
      },
    },
  }
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

function parseRunFinalizeInput(
  input: unknown,
  getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined
): AutomationsResult<AutomationsRunFinalizeInput> {
  const base = parseDefinitionInput(input, getWorkspaceSyncSnapshot)
  if (!base.ok) return base
  if (!isRecord(input)) return fail('invalid_input', 'Finalize input must be an object.')
  const runId = trimmedString(input.runId)
  if (!runId) return fail('invalid_input', 'runId is required.')
  if (input.outcome !== 'completed' && input.outcome !== 'failed') {
    return fail('invalid_input', "outcome must be 'completed' or 'failed'.")
  }
  return ok({
    ...base.value,
    runId,
    outcome: input.outcome,
    ...(trimmedString(input.summary) ? { summary: trimmedString(input.summary) } : {}),
  })
}

// The renderer treated post-write hook failures (webhook receiver refresh) as
// operation errors before the write core was extracted; keep that contract.
function withPostWriteFailure<T>(result: DefinitionWriteResult<T>): AutomationsResult<T> {
  if (!result.ok) return fail(result.code, result.message)
  if (result.postWriteFailure) return fail(result.postWriteFailure.code, result.postWriteFailure.message)
  return ok(result.value)
}

function engineRunNowResult(result: AutomationsEngineRunNowResult): AutomationsRunNowIpcResult {
  if (result.ok) return ok({ definition: definitionForRenderer(result.definition), run: result.run })
  return fail(result.problem.code, result.problem.message)
}

function engineFinalizeResult(result: AutomationsEngineFinalizeResult): AutomationsRunFinalizeResult {
  if (result.ok) return ok(result.run)
  return fail(result.problem.code, result.problem.message)
}

function snapshotRequiredIntegrations(provider: AutomationTriggerProvider | AutomationActionProvider): string[] {
  const value = ownDataProperty<unknown>(provider, 'requiredIntegrations', [])
  if (!Array.isArray(value)) return []
  return value.filter((integration): integration is string => typeof integration === 'string')
}

function ownDataProperty<T>(
  target: object,
  key: string,
  fallback: T
): T {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (!descriptor || !('value' in descriptor)) return fallback
  return descriptor.value as T
}

function fallbackConfigSchema(): Record<string, unknown> {
  return { type: 'object' }
}

function storeErrors<T>(errors: AutomationStoreProblem[]): AutomationsResult<T> {
  const [first] = errors
  if (!first) return fail('store_error', 'Automations store operation failed.')
  if (errors.length === 1) return storeError(first)
  return fail('store_error', `${errors.length} automations store files are malformed or unreadable.`)
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
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
