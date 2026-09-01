import { discoverSprintEngineRunStatePaths, readSprintRunSummary } from './sprintengine-run-index';
import { uniqueResolvedRoots } from './workspace-roots';
// The scheduler's own fallback (`currentAutoState` in sprint-runtime.ts) and the
// renderer store's default. A run's concurrency cap is renderer-persisted state
// main cannot read, so a headless registration starts at the shared default and
// the first window registration corrects it.
const DEFAULT_MAX_CONCURRENT_AGENTS = 3;
/**
 * Scan, filter, register. Returns what it did so the caller can log it and tests
 * can assert on the decisions rather than on side effects alone.
 */
export async function discoverSprintRunsAtBoot(deps) {
    const roots = uniqueResolvedRoots(deps.listWorkspaceRoots());
    const empty = { roots, discovered: 0, registered: [], skipped: [], disabled: false };
    // Safe mode / the auto-run kill switch stop the renderer bridge from
    // registering anything; discovery is the same scheduling gesture from the
    // other side and must honour them, or the switch would only work while a
    // window was open.
    if (sprintAutoRunDisabledByEnv(deps.env ?? process.env))
        return { ...empty, disabled: true };
    if (roots.length === 0)
        return empty;
    const discoverStatePaths = deps.discoverStatePaths ?? defaultDiscoverStatePaths;
    const readRunSummary = deps.readRunSummary ?? readSprintRunSummary;
    const statePaths = await discoverStatePaths(roots);
    const decisions = await Promise.all(statePaths.map(async (statePath) => {
        try {
            if (deps.isRunRegistered(statePath))
                return { statePath, skip: 'already_registered' };
            const record = await deps.readAutomationMode(statePath);
            if (!record)
                return { statePath, skip: 'no_intent' };
            if (record.desiredMode === 'manual')
                return { statePath, skip: 'manual' };
            const summary = await readRunSummary(statePath);
            if (summary.runtimeState === 'completed' || summary.runtimeState === 'canceled') {
                return { statePath, skip: 'terminal' };
            }
            if (summary.unknownKind === 'unsupported_store')
                return { statePath, skip: 'unsupported_store' };
            return { statePath, registration: buildBootRunRegistration(summary, record) };
        }
        catch {
            // One unreadable run must not cost every other run its resume.
            return { statePath, skip: 'unreadable' };
        }
    }));
    const report = { roots, discovered: statePaths.length, registered: [], skipped: [], disabled: false };
    for (const decision of decisions) {
        if ('skip' in decision) {
            report.skipped.push({ statePath: decision.statePath, reason: decision.skip });
            continue;
        }
        deps.registerRun(decision.registration);
        report.registered.push(decision.statePath);
    }
    return report;
}
/**
 * The registration main can build from disk alone. Identity comes from the run
 * index's summary (the same projection-derived name/project root the Sprints
 * door shows), and the scheduler's own durable bookkeeping comes from the
 * sidecar's runtime residue — the record `registerRun` would adopt anyway,
 * seeded here so the entry is correct even if that second read fails.
 *
 * `workspaceId` is synthetic and unique per run: two runs in the same project
 * must never share one id (the scheduler maps workspaceId → run entry, and a
 * collision would route one run's ports to the other). The first renderer
 * registration replaces it with the real workspace id.
 *
 * `memoryRelativeRoot` is renderer state main cannot read, and null is not a
 * degraded prompt: the persisted launch-settings mirror's `projectKnowledgeRoots`
 * resolves the project's knowledge root first anyway
 * (`shared/project-knowledge.ts`), and it survives a restart.
 */
export function buildBootRunRegistration(summary, record) {
    const residue = record.runtime;
    return {
        statePath: summary.statePath,
        workspaceId: bootDiscoveredWorkspaceId(summary.statePath),
        workspaceName: summary.teamName,
        folderPath: summary.projectRoot,
        memoryRelativeRoot: null,
        cliPermissionPreset: record.cliPermissionPreset ?? 'default',
        maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
        deliveredAgentNotificationEventKeys: residue?.deliveredAgentNotificationEventKeys ?? [],
        ...(residue?.completionTeardownAt !== undefined
            ? { completionTeardownAt: residue.completionTeardownAt }
            : {}),
        // No persisted lifecycle to carry: `idle` lets sidecar adoption decide.
        runtimeState: 'idle',
        rosterSessions: residue?.rosterSessions ?? {},
        agents: {},
        agentConfigs: {},
    };
}
/** The placeholder workspace id a boot-discovered run holds until a window claims it. */
export function bootDiscoveredWorkspaceId(statePath) {
    return `sprint-run:${statePath}`;
}
/**
 * The renderer's auto-run kill switches, read from the process environment:
 * `MULTICODE_SAFE_MODE` implies the auto-run one, and both are accepted with the
 * `VITE_` prefix because that is how they are set for a dev run (the renderer
 * reads them through `import.meta.env` — see `renderer/src/utils/runtimeFlags.ts`).
 */
export function sprintAutoRunDisabledByEnv(env) {
    return [
        'MULTICODE_SAFE_MODE',
        'VITE_MULTICODE_SAFE_MODE',
        'MULTICODE_DISABLE_SPRINTENGINE_AUTORUN',
        'VITE_MULTICODE_DISABLE_SPRINTENGINE_AUTORUN',
    ].some((name) => env[name] === '1');
}
async function defaultDiscoverStatePaths(roots) {
    const discovered = await discoverSprintEngineRunStatePaths(roots);
    return discovered.map((item) => item.statePath);
}
