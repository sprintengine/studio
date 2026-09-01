/**
 * Boot-time sprint run discovery (MC-2153) — the scheduler finds its runs with
 * no window open.
 *
 * Until this ran, `SprintRuntime` learned about a run only when a renderer
 * announced it (`sprintengineRuntimeBridge.ts`), so after a full app restart
 * scheduling resumed when a window opened — the honest scope limit the
 * sprint-runtime-ownership epic recorded (`docs/sprint-runtime-ownership-design.md`).
 * At app ready the sprint-engine module now scans the project roots main already
 * knows (`workspace-roots.ts`) with the SHARED run-index scan, reads each run's
 * `automation.json` intent, and registers the ones the user left auto-running.
 * Renderer registration becomes a reconcile against main's registry: the upsert
 * in `registerRun` keeps main's cycle state, delivered keys and lifecycle, so a
 * window opening later refreshes identity and configuration without resetting
 * anything the scheduler has been doing headlessly.
 *
 * What is deliberately NOT guessed: the desired mode (registration re-reads the
 * sidecar and adopts it — a scheduler must never spawn on a guess) and the
 * run's lifecycle. `paused` is only ever reached from a closed agent terminal or
 * a removed workspace — window-lifecycle events with no meaning across a
 * restart — while a user's own pause is a `manual` mode write, which is
 * persisted and skipped here. So a discovered run starts `idle` and the sidecar
 * adoption lifts it to `running` exactly when the persisted intent says so.
 */
import type { SprintEngineAutomationIntentRecord } from '../shared/sprintengine/automation-intent';
import type { SprintRuntimeRunRegistration } from '../shared/sprintengine/runtime-bridge';
import type { SprintRunSummary } from '../shared/sprintengine/runSummary';
/** Why a discovered run was not registered as active. */
export type SprintBootDiscoverySkip = 
/** No `automation.json` yet: the run predates the intent sidecar or was never started. */
'no_intent'
/** The user left it in manual mode — discovered, deliberately not scheduled. */
 | 'manual'
/** Completed or canceled: nothing left to schedule. */
 | 'terminal'
/** The store predates what this build reads; the scheduler could only fail on it. */
 | 'unsupported_store'
/** Its sidecar or projection could not be read at all — one bad run never stops the rest. */
 | 'unreadable'
/** A window beat discovery to it; the renderer's registration is the richer one. */
 | 'already_registered';
export type SprintBootDiscoveryReport = {
    /** Roots scanned, resolved and deduped. */
    roots: string[];
    /** Runs found under those roots. */
    discovered: number;
    /** State paths registered with the scheduler, in discovery order. */
    registered: string[];
    skipped: Array<{
        statePath: string;
        reason: SprintBootDiscoverySkip;
    }>;
    /** True when safe mode / the auto-run kill switch stopped the scan entirely. */
    disabled: boolean;
};
export type SprintBootDiscoveryDeps = {
    /** Project roots to scan — main's known workspace roots (never a home walk). */
    listWorkspaceRoots(): readonly string[];
    /** The run's persisted automation intent (`sprintengine-automation-service.ts`). */
    readAutomationMode(statePath: string): Promise<SprintEngineAutomationIntentRecord | null>;
    /** Already known to the scheduler (a window registered it first). */
    isRunRegistered(statePath: string): boolean;
    registerRun(registration: SprintRuntimeRunRegistration): void;
    /** Seams for tests; production uses the shared run index. */
    discoverStatePaths?(roots: string[]): Promise<string[]>;
    readRunSummary?(statePath: string): Promise<SprintRunSummary>;
    env?: NodeJS.ProcessEnv;
};
/**
 * Scan, filter, register. Returns what it did so the caller can log it and tests
 * can assert on the decisions rather than on side effects alone.
 */
export declare function discoverSprintRunsAtBoot(deps: SprintBootDiscoveryDeps): Promise<SprintBootDiscoveryReport>;
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
export declare function buildBootRunRegistration(summary: SprintRunSummary, record: SprintEngineAutomationIntentRecord): SprintRuntimeRunRegistration;
/** The placeholder workspace id a boot-discovered run holds until a window claims it. */
export declare function bootDiscoveredWorkspaceId(statePath: string): string;
/**
 * The renderer's auto-run kill switches, read from the process environment:
 * `MULTICODE_SAFE_MODE` implies the auto-run one, and both are accepted with the
 * `VITE_` prefix because that is how they are set for a dev run (the renderer
 * reads them through `import.meta.env` — see `renderer/src/utils/runtimeFlags.ts`).
 */
export declare function sprintAutoRunDisabledByEnv(env: NodeJS.ProcessEnv): boolean;
