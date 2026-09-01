/**
 * SprintCreateService — creating a sprint run is a main-process capability
 * (MC-2160).
 *
 * `sprint.create` was the last mutation the automation gateway delegated to a
 * window. Nothing about it needed one: initializing the Python run store,
 * scanning the backlog, composing the handoff prompt, and registering the
 * workspace are all things main can do. What kept it in the renderer was where
 * the CODE lived — the wizard's controllers and the workspace store — so a
 * headless `sprint.create` failed for want of a window, and a windowed one had
 * to wait up to 5s for a FlexLayout model to mount before the board could launch
 * the architect.
 *
 * That composition is shared now (`src/shared/sprintengine/workspace-creation.ts`
 * and `new-team-creation.ts`, byte-identical for both processes), and this
 * service is main's driver for it:
 *
 * - **The roster** resolves from the main-owned launch settings mirror
 *   (MC-2154), through the same `saved-rosters.ts` rules the wizard uses.
 * - **The runtime** (CLI/model/effort) validates against the plugin registry —
 *   the CLIs this app can actually launch.
 * - **The source plan** for a backlog/epic/selection launch comes from the
 *   shared backlog scan driven with node fs, so an epic brings its children and
 *   a multi-selection builds the same bundle the Backlog door builds.
 * - **The workspace** is adopted into main's registry (MC-2158), which makes the
 *   new id readable in the same call — no bus-confirmation poll.
 * - **The architect** is spawned by the scheduler, not by a board mount: the run
 *   registers with `SprintRuntime` and its persisted intent is written, and the
 *   cycle's run-start bootstrap takes it from there. That is the one behavioural
 *   change, and it is what makes creation work with zero windows.
 *
 * A run created here carries no board-mount spawn intent
 * (`sprintEngineInitialSpawnAgentIds`), so a window that is open cannot also
 * consume one — exactly one coordinator spawn either way.
 *
 * KNOWN LIMIT: the coordinator's handoff prompt is delivered to the scheduler
 * in this session only. The workspace registry deliberately strips a sprint
 * agent's `cliStartupPrompt` when it persists (`normalizeWorkspaceForRegistry`),
 * so an app restart between creation and the first spawn loses it, and the
 * coordinator starts on the plain agent prompt instead — it still discovers it
 * must plan through `sprintengine.agent.join`/`task.next`, and the run's sources
 * are already seeded into run.yaml, so this degrades rather than breaks.
 */
import type { SprintEngineArtifactCommandResult, SprintEngineStateInitializeInput } from '../shared/electron-api';
import type { SprintCreateRequest, SprintCreateResult } from '../shared/sprint-create';
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings';
import type { SprintEngineAutomationIntentRecord } from '../shared/sprintengine/automation-intent';
import type { SprintEngineAutomationMode, SprintEngineCliPermissionPreset } from '../shared/sprintengine/automation-types';
import type { SprintRuntimeRunRegistration } from '../shared/sprintengine/runtime-bridge';
import type { Workspace } from '../renderer/src/types/workspace';
import { type BacklogItem, type BacklogFilesystemAdapter } from '../shared/backlog/scan';
import { buildSprintEngineRunLink } from '../shared/backlog/sprintengine-links';
export type SprintCreateServiceDeps = {
    /** The launch settings main spawns with (MC-2154); saved rosters live here. */
    getLaunchSettings: () => SprintEngineLaunchSettings;
    /**
     * CLI plugin ids a sprint may staff: the hook-capable subset of the registry
     * (`cli.runtime.list` flags these `agentSelectable: true`; rows it flags
     * false are registry-held for install/detect only and are refused here).
     */
    listLaunchableClis: () => string[];
    /** The one-shot Python run-store init (`sprintengine-artifacts.ts`). */
    initializeSprintEngineState: (input: SprintEngineStateInitializeInput) => Promise<SprintEngineArtifactCommandResult>;
    /** Filesystem the backlog scan and source reads run against. */
    fs: BacklogFilesystemAdapter & {
        readFile: (path: string) => Promise<string>;
    };
    /** Mint the id the adopted workspace record carries. */
    newWorkspaceId: () => string;
    /** Commit a composed workspace record to main's registry. */
    adoptWorkspace: (workspace: Workspace, windowId: string, folderPath: string | null) => {
        ok: boolean;
        message?: string;
    };
    /** The window a new workspace joins — main's primary workspace window. */
    primaryWorkspaceWindowId: () => string;
    updateWorkspaceAgent: (workspaceId: string, agentId: string, patch: Partial<Workspace['agents'][string]>) => void;
    /** Seed the run's persisted automation intent (`sprintengine-automation-service.ts`). */
    hydrateAutomationMode: (input: {
        statePath: string;
        mode: SprintEngineAutomationMode;
    }) => Promise<{
        ok: boolean;
        message?: string;
        record?: SprintEngineAutomationIntentRecord;
    }>;
    setCliPermissionPreset: (input: {
        statePath: string;
        preset: SprintEngineCliPermissionPreset;
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** Hand the run to the main-process scheduler, which bootstraps its coordinator. */
    registerSprintRun: (registration: SprintRuntimeRunRegistration) => void;
    /** Record the Backlog execution link for a `backlog/` source. */
    addBacklogLink: (input: {
        workspaceRoot: string;
        relativePath: string;
        link: ReturnType<typeof buildSprintEngineRunLink>;
        status?: BacklogItem['status'];
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** Surface a start that could not be persisted; never silently swallowed. */
    logDiagnostic?: (input: {
        level: 'warning';
        title: string;
        message: string;
        details?: string;
    }) => void;
};
export type SprintCreateService = ReturnType<typeof createSprintCreateService>;
export declare function createSprintCreateService(deps: SprintCreateServiceDeps): {
    /**
     * Create (and, with `startRunner`, start) a Sprint Engine run. A
     * source-carrying request creates through the plan-sourced path; a
     * multi-source request rides the same function with the full ref list, and a
     * singleton list is the singular contract, byte-identical.
     */
    createSprint(request: SprintCreateRequest): Promise<SprintCreateResult>;
};
