import { AUTOMATIONS_CREATE_CHANNEL, AUTOMATIONS_DELETE_CHANNEL, AUTOMATIONS_ENGINE_STATUS_CHANNEL, AUTOMATIONS_GET_CHANNEL, AUTOMATIONS_INSTANCE_LIST_CHANNEL, AUTOMATIONS_LIST_CHANNEL, AUTOMATIONS_PROVIDERS_LIST_CHANNEL, AUTOMATIONS_RUN_NOW_CHANNEL, AUTOMATIONS_RUN_FINALIZE_CHANNEL, AUTOMATIONS_RUNS_LIST_CHANNEL, AUTOMATIONS_UPDATE_CHANNEL, } from '../../shared/automations/contracts';
import { createDefinitionWriteCore, parseDefinitionDraft, parseDefinitionPatch, storeError, validateKnownWorkspaceRoot, } from '../automations/definition-write';
import { buildAutomationsInstanceIndex, } from '../automations/instance-index';
import { projectFoldersFromWorkspaceSyncSnapshot, } from '../automations/engine';
import { allowAutomationProvider, automationProviderBlockedReason, } from '../automations/provider-registry';
import { AutomationsStore } from '../automations/store';
import { WEBHOOK_TRIGGER_KIND } from '../automations/triggers/webhook';
export function registerAutomationsIpc(host, deps) {
    const createStore = deps.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot));
    const staticTriggerProviders = deps.triggerProviders ?? [];
    const staticActionProviders = deps.actionProviders ?? [];
    const getTriggerProviders = deps.getTriggerProviders ?? (() => staticTriggerProviders);
    const getActionProviders = deps.getActionProviders ?? (() => staticActionProviders);
    const getTriggerProviderRegistrations = deps.getTriggerProviderRegistrations
        ?? (() => deps.triggerProviderRegistrations ?? getTriggerProviders().map((provider) => legacyProviderRegistration('trigger', provider)));
    const getActionProviderRegistrations = deps.getActionProviderRegistrations
        ?? (() => deps.actionProviderRegistrations ?? getActionProviders().map((provider) => legacyProviderRegistration('action', provider)));
    const checkProviderPermission = deps.checkProviderPermission ?? allowAutomationProvider;
    const now = deps.now ?? Date.now;
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
    });
    host.registerIpc(AUTOMATIONS_LIST_CHANNEL, async (_event, input) => {
        const workspaceRoot = parseWorkspaceRoot(input, deps.getWorkspaceSyncSnapshot);
        if (!workspaceRoot.ok)
            return workspaceRoot;
        const definitions = await createStore(workspaceRoot.value).listDefinitions();
        if (!definitions.ok)
            return storeErrors(definitions.errors);
        return ok(definitions.values.map(definitionForRenderer));
    });
    host.registerIpc(AUTOMATIONS_GET_CHANNEL, async (_event, input) => {
        const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot);
        if (!parsed.ok)
            return parsed;
        const definition = await writeCore.get(parsed.value.workspaceRoot, parsed.value.automationId);
        if (!definition.ok)
            return definition;
        return ok(definitionForRenderer(definition.value));
    });
    // Shared by the IPC channel and the app-level front door (automation server
    // tools): one parse+write pipeline, so external creates get the identical
    // validation, ownership stamping, and post-write refresh.
    const createDefinition = async (input) => {
        const parsed = parseCreateInput(input, deps.getWorkspaceSyncSnapshot);
        if (!parsed.ok)
            return parsed;
        const created = withPostWriteFailure(await writeCore.create(parsed.value.workspaceRoot, parsed.value.definition));
        if (!created.ok)
            return created;
        return ok(definitionForRenderer(created.value));
    };
    // The marketplace install path (no IPC channel of its own — the marketplace's
    // own install handler calls this). Same workspace-root trust gate as every
    // other write, so a shelf install can only ever land in a project the app has
    // open: an install with no target refuses rather than picking one.
    const installCatalogueDefinition = async (input) => {
        const workspaceRoot = parseWorkspaceRoot(input, deps.getWorkspaceSyncSnapshot);
        if (!workspaceRoot.ok)
            return workspaceRoot;
        if (!isRecord(input) || typeof input.sourceCatalogueId !== 'string') {
            return fail('invalid_input', 'sourceCatalogueId is required.');
        }
        const sourcePublisher = trimmedString(input.sourcePublisher);
        const installed = withPostWriteFailure(await writeCore.installFromCatalogue(workspaceRoot.value, {
            payload: input.definition,
            sourceCatalogueId: input.sourceCatalogueId,
            ...(sourcePublisher ? { sourcePublisher } : {}),
        }));
        if (!installed.ok)
            return installed;
        return ok({
            definition: definitionForRenderer(installed.value.definition),
            alreadyAdded: installed.value.alreadyAdded,
            workspaceRoot: workspaceRoot.value,
        });
    };
    const runNow = async (input) => {
        const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot);
        if (!parsed.ok)
            return parsed;
        const result = await deps.engine.runNow(parsed.value);
        return engineRunNowResult(result);
    };
    // Shared by the update channel and the app-level front door, exactly as
    // createDefinition is: the mobile `automations.control` command enables and
    // pauses through this, so the phone's write gets the identical patch parse,
    // provider validation, next-run recompute and post-write refresh the desktop
    // UI's own toggle gets — rather than a second write path onto the same store.
    const updateDefinition = async (input) => {
        const parsed = parseUpdateInput(input, deps.getWorkspaceSyncSnapshot);
        if (!parsed.ok)
            return parsed;
        const written = withPostWriteFailure(await writeCore.update(parsed.value.workspaceRoot, parsed.value.automationId, parsed.value.patch));
        if (!written.ok)
            return written;
        return ok(definitionForRenderer(written.value));
    };
    host.registerIpc(AUTOMATIONS_CREATE_CHANNEL, async (_event, input) => {
        return createDefinition(input);
    });
    host.registerIpc(AUTOMATIONS_UPDATE_CHANNEL, async (_event, input) => {
        return updateDefinition(input);
    });
    host.registerIpc(AUTOMATIONS_DELETE_CHANNEL, async (_event, input) => {
        const parsed = parseDefinitionInput(input, deps.getWorkspaceSyncSnapshot);
        if (!parsed.ok)
            return parsed;
        const deleted = withPostWriteFailure(await writeCore.remove(parsed.value.workspaceRoot, parsed.value.automationId));
        if (!deleted.ok)
            return deleted;
        return ok(deleted.value);
    });
    host.registerIpc(AUTOMATIONS_RUN_NOW_CHANNEL, async (_event, input) => {
        return runNow(input);
    });
    host.registerIpc(AUTOMATIONS_RUN_FINALIZE_CHANNEL, async (_event, input) => {
        const parsed = parseRunFinalizeInput(input, deps.getWorkspaceSyncSnapshot);
        if (!parsed.ok)
            return parsed;
        const result = await deps.engine.finalizeRun(parsed.value);
        return engineFinalizeResult(result);
    });
    host.registerIpc(AUTOMATIONS_RUNS_LIST_CHANNEL, async (_event, input) => {
        const parsed = parseRunsListInput(input, deps.getWorkspaceSyncSnapshot);
        if (!parsed.ok)
            return parsed;
        const runs = await createStore(parsed.value.workspaceRoot).listRuns(parsed.value.automationId);
        if (!runs.ok)
            return storeErrors(runs.errors);
        return ok(runs.values);
    });
    host.registerIpc(AUTOMATIONS_PROVIDERS_LIST_CHANNEL, async () => {
        return ok({
            triggers: getTriggerProviderRegistrations().map((registration) => providerView(registration, deps.isIntegrationAvailable, checkProviderPermission)),
            actions: getActionProviderRegistrations().map((registration) => providerView(registration, deps.isIntegrationAvailable, checkProviderPermission)),
        });
    });
    host.registerIpc(AUTOMATIONS_INSTANCE_LIST_CHANNEL, async () => {
        const snapshot = deps.getWorkspaceSyncSnapshot?.();
        const projectFolders = deps.getProjectFolders?.()
            ?? (snapshot ? projectFoldersFromWorkspaceSyncSnapshot(snapshot) : []);
        const index = await buildAutomationsInstanceIndex({
            projectFolders,
            createStore,
            // Redact webhook secrets on the way out, exactly as the per-project list.
            mapDefinition: definitionForRenderer,
        });
        return ok(index);
    });
    host.registerIpc(AUTOMATIONS_ENGINE_STATUS_CHANNEL, async () => {
        const status = deps.getEngineSidecarStatus?.();
        if (!status)
            return ok({ state: 'unavailable' });
        return ok({ state: status.state, ...(status.error ? { error: status.error } : {}) });
    });
    return { createDefinition, updateDefinition, installCatalogueDefinition, runNow };
}
function providerView(registration, isIntegrationAvailable, checkProviderPermission) {
    const blockedReason = automationProviderBlockedReason(registration, checkProviderPermission(registration));
    const requiredIntegrations = registration.requiredIntegrations;
    return {
        kind: registration.kind,
        configSchema: registration.configSchema,
        requiredIntegrations,
        missingIntegrations: requiredIntegrations.filter((id) => isIntegrationAvailable?.(id) !== true),
        ...(blockedReason ? { blockedReason } : {}),
    };
}
function legacyProviderRegistration(providerType, provider) {
    return {
        providerId: provider.kind,
        moduleId: 'automations',
        providerType,
        kind: provider.kind,
        configSchema: ownDataProperty(provider, 'configSchema', fallbackConfigSchema()),
        requiredIntegrations: snapshotRequiredIntegrations(provider),
        provider,
    };
}
function definitionForRenderer(definition) {
    const config = definition.trigger.config;
    if (definition.trigger.kind !== WEBHOOK_TRIGGER_KIND || !isRecord(config))
        return definition;
    const { secret, ...redactedConfig } = config;
    return {
        ...definition,
        trigger: {
            ...definition.trigger,
            config: {
                ...redactedConfig,
                hasSecret: typeof secret === 'string' && secret.trim().length > 0,
            },
        },
    };
}
function parseWorkspaceRoot(input, getWorkspaceSyncSnapshot) {
    if (!isRecord(input) || typeof input.workspaceRoot !== 'string' || input.workspaceRoot.trim() === '') {
        return fail('invalid_input', 'workspaceRoot is required.');
    }
    const workspaceRoot = input.workspaceRoot.trim();
    const trustedRoot = validateKnownWorkspaceRoot(workspaceRoot, getWorkspaceSyncSnapshot);
    if (!trustedRoot.ok)
        return trustedRoot;
    return ok(trustedRoot.value);
}
function parseDefinitionInput(input, getWorkspaceSyncSnapshot) {
    const workspaceRoot = parseWorkspaceRoot(input, getWorkspaceSyncSnapshot);
    if (!workspaceRoot.ok)
        return workspaceRoot;
    if (!isRecord(input) || typeof input.automationId !== 'string' || input.automationId.trim() === '') {
        return fail('invalid_input', 'automationId is required.');
    }
    const workspaceId = trimmedString(input.workspaceId);
    return ok({
        workspaceRoot: workspaceRoot.value,
        ...(workspaceId ? { workspaceId } : {}),
        automationId: input.automationId.trim(),
    });
}
function parseCreateInput(input, getWorkspaceSyncSnapshot) {
    const workspaceRoot = parseWorkspaceRoot(input, getWorkspaceSyncSnapshot);
    if (!workspaceRoot.ok)
        return workspaceRoot;
    if (!isRecord(input))
        return fail('invalid_input', 'Automation create input must be an object.');
    const definition = parseDefinitionDraft(input.definition);
    if (!definition.ok)
        return definition;
    return ok({ workspaceRoot: workspaceRoot.value, definition: definition.value });
}
function parseUpdateInput(input, getWorkspaceSyncSnapshot) {
    const base = parseDefinitionInput(input, getWorkspaceSyncSnapshot);
    if (!base.ok)
        return base;
    if (!isRecord(input))
        return fail('invalid_input', 'Automation update input must be an object.');
    const patch = parseDefinitionPatch(input.patch);
    if (!patch.ok)
        return patch;
    return ok({ ...base.value, patch: patch.value });
}
function parseRunsListInput(input, getWorkspaceSyncSnapshot) {
    return parseDefinitionInput(input, getWorkspaceSyncSnapshot);
}
function parseRunFinalizeInput(input, getWorkspaceSyncSnapshot) {
    const base = parseDefinitionInput(input, getWorkspaceSyncSnapshot);
    if (!base.ok)
        return base;
    if (!isRecord(input))
        return fail('invalid_input', 'Finalize input must be an object.');
    const runId = trimmedString(input.runId);
    if (!runId)
        return fail('invalid_input', 'runId is required.');
    if (input.outcome !== 'completed' && input.outcome !== 'failed') {
        return fail('invalid_input', "outcome must be 'completed' or 'failed'.");
    }
    return ok({
        ...base.value,
        runId,
        outcome: input.outcome,
        ...(trimmedString(input.summary) ? { summary: trimmedString(input.summary) } : {}),
    });
}
// The renderer treated post-write hook failures (webhook receiver refresh) as
// operation errors before the write core was extracted; keep that contract.
function withPostWriteFailure(result) {
    if (!result.ok)
        return fail(result.code, result.message);
    if (result.postWriteFailure)
        return fail(result.postWriteFailure.code, result.postWriteFailure.message);
    return ok(result.value);
}
function engineRunNowResult(result) {
    if (result.ok)
        return ok({ definition: definitionForRenderer(result.definition), run: result.run });
    return fail(result.problem.code, result.problem.message);
}
function engineFinalizeResult(result) {
    if (result.ok)
        return ok(result.run);
    return fail(result.problem.code, result.problem.message);
}
function snapshotRequiredIntegrations(provider) {
    const value = ownDataProperty(provider, 'requiredIntegrations', []);
    if (!Array.isArray(value))
        return [];
    return value.filter((integration) => typeof integration === 'string');
}
function ownDataProperty(target, key, fallback) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !('value' in descriptor))
        return fallback;
    return descriptor.value;
}
function fallbackConfigSchema() {
    return { type: 'object' };
}
function storeErrors(errors) {
    const [first] = errors;
    if (!first)
        return fail('store_error', 'Automations store operation failed.');
    if (errors.length === 1)
        return storeError(first);
    return fail('store_error', `${errors.length} automations store files are malformed or unreadable.`);
}
function trimmedString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function ok(value) {
    return { ok: true, value };
}
function fail(code, message) {
    return { ok: false, code, message };
}
