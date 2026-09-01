import { join } from 'node:path';
import { createGitWorktree, removeGitWorktree } from '../git';
import { resolveRepoRoot } from '../git-worktree-validation';
import { runSkillLoopAction } from './actions/run-skill-loop';
import { runSpawnAgentAction } from './actions/spawn-agent';
import { allowAutomationProvider, createBuiltInAutomationProviderRegistry, executableActionProviders, isFirstPartyAutomationProviderModule, } from './provider-registry';
export class AutomationActionBlockedError extends Error {
    blockedReason;
    constructor(blockedReason) {
        super(blockedReason);
        this.blockedReason = blockedReason;
        this.name = 'AutomationActionBlockedError';
    }
}
export class RunWorktreeUnavailableError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'RunWorktreeUnavailableError';
    }
}
const DEFAULT_LAUNCH_CONFIRM_POLL_INTERVAL_MS = 150;
// The launch resolves once main has spawned the pty, so the session's execution
// identity is normally registered by the time this is read. Kept as a bounded
// poll because registration and the resolver's own view are still two steps.
const DEFAULT_EXECUTION_ID_TIMEOUT_MS = 10_000;
export function createLocalAutomationExecutor(options) {
    const builtInRegistry = options.actionProviders
        || options.getActionProviders
        || options.actionProviderRegistrations
        || options.getActionProviderRegistrations
        ? null
        : createBuiltInAutomationProviderRegistry();
    const staticProviders = options.actionProviders ?? builtInRegistry?.listActionProviders() ?? createBuiltInAutomationActionProviders();
    const getActionProviders = options.getActionProviders ?? (() => staticProviders);
    const staticRegistrations = options.actionProviderRegistrations ?? builtInRegistry?.listActionProviderRegistrations();
    const getActionProviderRegistrations = options.getActionProviderRegistrations
        ?? (staticRegistrations ? () => staticRegistrations : undefined);
    const checkProviderPermission = options.checkProviderPermission ?? allowAutomationProvider;
    return async (input) => {
        const registrations = getActionProviderRegistrations?.();
        const providers = registrations
            ? executableActionProviders(registrations, checkProviderPermission)
            : getActionProviders();
        return runLocalAutomationAction(input, providers, options, registrations);
    };
}
export function createBuiltInAutomationActionProviders(options) {
    return createBuiltInAutomationProviderRegistry(options).listActionProviders();
}
export async function runLocalAutomationAction(input, providers, options, registrations) {
    const provider = providers.find((candidate) => candidate.kind === input.definition.action.kind);
    if (!provider) {
        return {
            status: 'blocked',
            blockedReason: `No built-in automation action is registered for "${input.definition.action.kind}".`,
            summary: 'Automation action blocked before launch because no local provider is registered.',
        };
    }
    const progress = [];
    const context = createActionContext(input, options, (patch) => {
        progress.push(patch);
    });
    try {
        const runtime = {
            definition: input.definition,
            runId: input.run.id,
            workspaceRoot: input.workspaceRoot,
            // Opt-in trigger context: spawn-agent/run-skill-loop surface this payload in
            // the launch prompt only when their config sets includeTriggerContext.
            triggerPayload: input.triggerPayload,
            // Launch target precedence: an explicit config workspaceId (legacy/MCP
            // path) wins and launches into that named workspace; otherwise the default
            // automation route resolves-or-creates the per-project hidden
            // automations-host workspace for the run's folder. No standard workspace is
            // reused or created for the default route.
            resolveSpawnAgentTarget: (target) => Promise.resolve(resolveLaunchTarget(target, options)),
            // Agent-backed runs launch into a per-run worktree so the agent's work
            // (and its PR) is isolated from the user's checkout. Isolation is not
            // best-effort: a run that asks for a worktree and cannot get one is
            // blocked, never downgraded to the user's checkout — an unattended agent
            // runs with permissions bypassed, and a run with no worktree also has no
            // branch and so no pull request to review. A definition can opt out
            // (runInWorktree === false) to run directly in the workspace checkout, and
            // that opt-out is the user's to make. Absent ⇒ true, so existing
            // automations keep their per-run worktree.
            spawnAgent: async (spawnInput) => {
                // A connector run writes the connector's MCP config into the agent's cwd,
                // so it must land in an isolated worktree — never the user's checkout. A
                // connectorId therefore forces a worktree even when the definition opted
                // out, preserving the connector-chat isolation invariant.
                const wantsWorktree = spawnInput.connectorId != null || input.definition.runInWorktree !== false;
                const worktree = wantsWorktree ? await ensureRunWorktree(input, options, spawnInput.connectorId) : null;
                const launched = await spawnAgent({ ...spawnInput, worktreePath: worktree?.worktreePath }, options);
                return { ...launched, worktreePath: worktree?.worktreePath, branch: worktree?.branch };
            },
            requireIntegration: context.requireIntegration,
        };
        const registration = registrations?.find((candidate) => candidate.kind === provider.kind);
        const firstPartyResolvedProvider = registration
            ? provider === registration.provider && isFirstPartyAutomationProviderModule(registration.moduleId)
            : false;
        const providerResult = firstPartyResolvedProvider && provider.kind === 'spawn-agent'
            ? await runSpawnAgentAction(input.definition.action.config, runtime)
            : firstPartyResolvedProvider && provider.kind === 'run-skill-loop'
                ? await runSkillLoopAction(input.definition.action.config, runtime)
                : await provider.run(input.definition.action.config, context);
        return Object.assign({}, ...progress, providerResult);
    }
    catch (error) {
        if (error instanceof AutomationActionBlockedError) {
            return {
                status: 'blocked',
                blockedReason: error.blockedReason,
                summary: 'Automation action blocked before launch.',
            };
        }
        return {
            status: 'failed',
            summary: error instanceof Error ? error.message : 'Automation action failed.',
        };
    }
}
export function createActionContext(input, options, reportProgress) {
    return {
        automationId: input.definition.id,
        runId: input.run.id,
        workspaceRoot: input.workspaceRoot,
        triggerPayload: input.triggerPayload,
        spawnAgent: (spawnInput) => spawnAgent(spawnInput, options),
        runCommand: async () => {
            throw new AutomationActionBlockedError('run-command is deferred from Phase 1 and is not available as a built-in action.');
        },
        reportProgress,
        requireIntegration: (id) => {
            const available = options.isIntegrationAvailable?.(id);
            if (available !== true)
                throw new AutomationActionBlockedError(`Required integration is unavailable or unverified: ${id}`);
        },
    };
}
async function spawnAgent(input, options) {
    const target = input.resolvedTarget ?? resolveLaunchTarget(input, options);
    // The host is the durable per-project Automations workspace, so it carries the
    // stable surface name — never the launching run's agent name, which would brand
    // the shared host after whichever automation happened to create it.
    const workspaceId = target.workspaceId ?? createWorkspace({
        folderPath: target.folderPath,
        name: 'Automations',
    }, options);
    const launched = await options.launchAgent({
        workspaceId,
        cli: input.cli,
        cliModel: input.cliModel,
        permissionPreset: input.permissionPreset,
        specialistId: input.specialistId,
        worktreePath: input.worktreePath,
        connectorId: input.connectorId,
        spawnSkillId: input.spawnSkillId,
        name: input.name,
        prompt: input.prompt,
    });
    if (!launched.ok)
        throw new Error(launched.message);
    if (launched.workspaceId !== workspaceId) {
        throw new Error(`The agent launched in workspace "${launched.workspaceId}" instead of "${workspaceId}".`);
    }
    const agentId = launched.agentId;
    // Secondary correlation key for agent-lifecycle finalization. The launch call
    // returns once the pty exists, but the runtime registers the session's
    // execution identity as part of that spawn, so this now resolves promptly
    // instead of racing a renderer that had not written the agent record yet. Kept
    // as a poll: best-effort, and a permanent miss must not fail the launch — the
    // run still correlates on (workspaceId, agentId).
    const executionId = options.resolveAgentExecutionId
        ? await waitFor(options.executionIdTimeoutMs ?? DEFAULT_EXECUTION_ID_TIMEOUT_MS, options.launchConfirmPollIntervalMs ?? DEFAULT_LAUNCH_CONFIRM_POLL_INTERVAL_MS, options, () => options.resolveAgentExecutionId?.({ workspaceId, agentId }) ?? null) ?? undefined
        : undefined;
    return { workspaceId, agentId, executionId };
}
// Fails the run rather than returning "no worktree": every caller asked for
// isolation, and there is nowhere else to put an unattended agent. The blocked
// reason names the cause so a run blocked for want of a git repository is not
// read as a run whose worktree creation failed.
async function ensureRunWorktree(input, options, connectorId) {
    const creator = options.createRunWorktree ?? defaultCreateRunWorktree;
    try {
        const worktree = await creator({ workspaceRoot: input.workspaceRoot, runId: input.run.id });
        // A creator that resolves to nothing is the old swallowed failure wearing a
        // different shape. The types forbid it; this is the boundary that enforces
        // it, because an injected creator is the one input here that TypeScript does
        // not get to check at runtime.
        if (!worktree)
            throw new RunWorktreeUnavailableError('worktree_creation_failed', 'no worktree was returned');
        return worktree;
    }
    catch (error) {
        const subject = connectorId
            ? `Connector automation run for "${connectorId}" requires an isolated worktree`
            : 'This automation runs in its own git worktree';
        const cause = error instanceof RunWorktreeUnavailableError && error.reason === 'not_a_git_repository'
            ? `${input.workspaceRoot} is not a git repository`
            : `worktree creation failed: ${error instanceof Error ? error.message : 'unknown error'}`;
        throw new AutomationActionBlockedError(`${subject}, but ${cause}. The run was blocked rather than launched in the workspace checkout.`);
    }
}
export async function defaultCreateRunWorktree(input) {
    const branchName = `automations/${input.runId}`;
    const created = await createGitWorktree({
        repoRoot: input.workspaceRoot,
        containerPath: join(input.workspaceRoot, '.multi-code', 'automations', 'worktrees'),
        destinationPath: input.runId,
        branchName,
        baseRef: 'HEAD',
    });
    if (created.ok)
        return { worktreePath: created.data.path, branch: created.data.branch ?? branchName };
    // createGitWorktree resolves the repo root first, so classify by re-running
    // that one check — only on the failure path, leaving the happy path at a
    // single git invocation.
    const repoRoot = await resolveRepoRoot(input.workspaceRoot);
    throw new RunWorktreeUnavailableError(repoRoot.ok ? 'worktree_creation_failed' : 'not_a_git_repository', created.message);
}
export async function defaultRemoveRunWorktree(input) {
    await removeGitWorktree({ repoRoot: input.workspaceRoot, path: input.worktreePath, force: true });
}
// An explicit config workspaceId (legacy/MCP) launches into that named standard
// workspace; the default automation route resolves-or-creates the per-project
// hidden automations-host workspace for the run's folder.
function resolveLaunchTarget(input, options) {
    return input.workspaceId
        ? resolveStandardLaunchTarget(input.workspaceId, input.folderPath, options)
        : resolveHostLaunchTarget(input.folderPath, options);
}
// Resolve the per-project automations-host workspace for a folder. Returns the
// existing host's target when one is open, or a bare `{ folderPath }` so
// `createWorkspace` creates a fresh host — never a standard workspace.
function resolveHostLaunchTarget(folderPath, options) {
    const host = findHostWorkspaceByFolder(options.getWorkspaceSyncSnapshot(), folderPath);
    return host
        ? { workspaceId: host.id, folderPath: host.folderPath?.trim() || folderPath }
        : { folderPath };
}
// Explicit config workspaceId (legacy/MCP): launch into that named standard
// workspace, or a folder-matched standard workspace when the named one is not a
// standard workspace. Only reached when a workspaceId is provided.
function resolveStandardLaunchTarget(workspaceId, folderPath, options) {
    const snapshot = options.getWorkspaceSyncSnapshot();
    const explicitWorkspace = findWorkspaceById(snapshot, workspaceId);
    if (!explicitWorkspace) {
        throw new Error(`Workspace "${workspaceId}" is not known to the workspace-sync bus.`);
    }
    if (isStandardWorkspace(explicitWorkspace)) {
        return {
            workspaceId: explicitWorkspace.id,
            folderPath: explicitWorkspace.folderPath?.trim() || folderPath,
        };
    }
    const targetFolderPath = explicitWorkspace.folderPath?.trim() || folderPath;
    const standardWorkspace = findStandardWorkspaceByFolder(snapshot, targetFolderPath);
    return standardWorkspace
        ? {
            workspaceId: standardWorkspace.id,
            folderPath: standardWorkspace.folderPath?.trim() || targetFolderPath,
        }
        : { folderPath: targetFolderPath };
}
function createWorkspace(input, options) {
    const created = options.createWorkspace({
        name: input.name,
        folderPath: input.folderPath,
        mode: AUTOMATIONS_HOST_WORKSPACE_MODE,
    }, 'automation');
    if (!created.ok)
        throw new Error(created.message);
    const workspace = created.result.workspace;
    if (!isAutomationsHostWorkspace(workspace)) {
        throw new Error(`Created workspace "${workspace.id}" is a ${workspace.mode} workspace; `
            + 'automation agent launch requires an automations-host workspace.');
    }
    return workspace.id;
}
function findWorkspaceById(snapshot, workspaceId) {
    return snapshot.state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}
function findStandardWorkspaceByFolder(snapshot, folderPath) {
    const key = normalizeFolderKey(folderPath);
    if (!key)
        return null;
    return snapshot.state.workspaces.find((workspace) => isStandardWorkspace(workspace) && normalizeFolderKey(workspace.folderPath) === key) ?? null;
}
function findHostWorkspaceByFolder(snapshot, folderPath) {
    const key = normalizeFolderKey(folderPath);
    if (!key)
        return null;
    return snapshot.state.workspaces.find((workspace) => isAutomationsHostWorkspace(workspace) && normalizeFolderKey(workspace.folderPath) === key) ?? null;
}
function isStandardWorkspace(workspace) {
    return workspace.mode === 'standard';
}
// Mode literal mirrors AUTOMATIONS_HOST_WORKSPACE_MODE in the renderer's
// types/workspace.ts. Main and renderer are separate TS projects, so this file
// matches a literal here (as isStandardWorkspace does for 'standard') rather than
// value-importing across the project boundary.
const AUTOMATIONS_HOST_WORKSPACE_MODE = 'automations-host';
function isAutomationsHostWorkspace(workspace) {
    return workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE;
}
function normalizeFolderKey(folderPath) {
    const trimmed = folderPath?.trim();
    return trimmed ? trimmed.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() : null;
}
async function waitFor(timeoutMs, pollIntervalMs, options, probe) {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + timeoutMs;
    for (;;) {
        const found = probe();
        if (found !== null)
            return found;
        if (now() >= deadline)
            return null;
        await sleep(pollIntervalMs);
    }
}
