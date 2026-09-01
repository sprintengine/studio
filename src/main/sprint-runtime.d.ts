import type { DiagnosticLogEntry, DiagnosticLogInput, MemoryRootStatus, SprintEngineArtifactCommandResult, SprintEngineProjectionReadResult, SprintEngineTaskWorktreeResult, TerminalSessionSnapshot, TerminalSpawnResult } from '../shared/electron-api';
import type { PluginRegistryListEntry } from '../shared/plugin-manifest';
import type { SprintEngineRosterSession, SprintEngineWorkspaceView } from '../shared/sprintengine/run-types';
import type { SprintEngineAutomationIntentRecord, SprintEngineAutomationRuntimeResidue } from '../shared/sprintengine/automation-intent';
import type { TerminalSpawnArgs } from '../shared/sprintengine/auto-run-executor';
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings';
import type { SprintRuntimeOp, SprintRuntimeRunRegistration, SprintRuntimeStopReasonPush } from '../shared/sprintengine/runtime-bridge';
import type { SprintPowerManager } from './sprint-power-manager';
export type SprintRuntimeDeps = {
    terminal: {
        list(): TerminalSessionSnapshot[];
        write(sessionId: string, data: string): void;
        /**
         * Deliver a dispatch prompt through the agent control plane (MC-102): one
         * serialized turn per session, so a review-guide prompt or a future
         * composer send cannot land between this paste and its submit. Optional so
         * a test harness can drive the raw write seam.
         */
        sendPrompt?(sessionId: string, text: string): Promise<{
            ok: boolean;
            message?: string;
        }>;
        kill(sessionId: string): void;
        status(sessionId: string): Promise<{
            processAlive: boolean;
        }>;
        /** In-process spawn; fails cleanly when no window can host the terminal view (Phase 2 limit). */
        spawn(args: TerminalSpawnArgs): Promise<TerminalSpawnResult>;
        /**
         * Move a run's live sessions onto a new workspace id (MC-2153): a
         * boot-discovered run spawns under a placeholder id and adopts the window's
         * real one, and every workspace-keyed session lookup outside the scheduler
         * — the board roster, duplicate-session disposal — must follow it.
         */
        adoptWorkspaceId?(input: {
            statePath: string;
            workspaceId: string;
        }): void;
    };
    artifacts: {
        readProjection(input: {
            statePath: string;
            knownToken?: string;
        }): Promise<SprintEngineProjectionReadResult>;
        autoApproveArtifact(input: {
            statePath: string;
            artifactId: string;
        }): Promise<SprintEngineArtifactCommandResult>;
        ensureTaskWorktree(input: {
            statePath: string;
            taskId: string;
        }): Promise<SprintEngineTaskWorktreeResult>;
    };
    pathExists(path: string): Promise<boolean>;
    resolveMemoryRoot(workspaceRoot: string | null, relativeRoot: string | null): Promise<MemoryRootStatus>;
    getPluginCatalogEntries(): readonly PluginRegistryListEntry[];
    getLaunchSettings(): SprintEngineLaunchSettings;
    readAutomationMode(statePath: string): Promise<SprintEngineAutomationIntentRecord | null>;
    /**
     * Durable scheduler bookkeeping (Phase 3): persists delivered notification
     * keys, the completion-teardown marker, and roster resume records into the
     * automation sidecar so headless retirements and completions survive with
     * zero windows and an app restart re-adopts main's own record rather than a
     * stale renderer mirror. Fire-and-forget.
     */
    persistRuntimeResidue(statePath: string, runtime: SprintEngineAutomationRuntimeResidue): void;
    powerManager: Pick<SprintPowerManager, 'markRunActive' | 'markRunInactive' | 'shutdown'>;
    broadcastOp(op: SprintRuntimeOp): void;
    /**
     * Tell the cross-project run index (the Sprints door) a run's on-disk state
     * changed OUTSIDE any registered runtime — e.g. a cancel of a run whose
     * workspace is not resident. Ops from registered runs already notify the
     * index via broadcastOp; this is the non-resident escape hatch.
     */
    notifyRunsChanged?(statePath: string): void;
    logDiagnostic(input: DiagnosticLogInput): Promise<DiagnosticLogEntry | void> | void;
    now?(): number;
    timers?: {
        setInterval(handler: () => void, ms: number): unknown;
        clearInterval(handle: unknown): void;
    };
};
export type SprintRuntime = ReturnType<typeof createSprintRuntime>;
export declare function createSprintRuntime(deps: SprintRuntimeDeps): {
    /**
     * The registered run a workspace's auto-run events belong to (MC-1754
     * Phase 3): feeds the on-disk runner log's per-run file resolution.
     * First match wins — a workspace holds one active sprint run entry.
     */
    resolveRunnerLogTarget(workspaceId: string): {
        statePath: string;
        folderPath: string | null;
    } | null;
    /** Renderer announces/refreshes a sprint run's context. Idempotent upsert. */
    registerRun(registration: SprintRuntimeRunRegistration): void;
    /**
     * The Phase 1 service hydrated a legacy run's sidecar (first write, no
     * broadcast): adopt the now-authoritative mode here — without this a
     * freshly created or legacy run whose registration raced the hydration
     * would sit at `manual` in the scheduler forever while the board showed
     * an automation mode. Lifecycle-preserving (see `adoptDesiredMode`).
     */
    adoptAutomationRecord(statePath: string, record: SprintEngineAutomationIntentRecord): void;
    /** Renderer stops tracking a run (workspace removed). */
    unregisterRun(statePath: string): void;
    /**
     * Renderer-originated resume (the board's Resume control, a future mobile
     * resume): a paused/blocked/failed run re-enters `running` without a mode
     * change — `runner_started` is the designed same-mode recovery gesture and
     * has no other path into main (same-mode intent writes are structural
     * no-ops by design). Wakes the tick loop immediately.
     */
    applyResume(statePath: string): void;
    /**
     * Input-resolution recovery: a run the cycle parked on `blocked` re-enters
     * `running` once a needs_input resolution lands (the engine mutation has
     * already moved the task out of needs_input, so the next cycle only
     * re-blocks if a DIFFERENT user blocker remains — the correct outcome).
     * Deliberately narrower than applyResume: `paused` is a user gesture and
     * `failed` needs attention — resolving an input must restart neither.
     * Unlike applyResume (whose initiating window applies runner_started
     * locally), this transition originates in main, so it broadcasts
     * `automation_resumed` for every window to clear its Blocked pill.
     */
    resumeIfBlocked(statePath: string): void;
    /**
     * User-initiated run cancellation (MC-1604). Called after the engine cancel
     * op has written run/task status; parks the run in terminal `canceled`
     * dormancy with the shared completion teardown (records sessions, disposes
     * PTYs, removes panels, stops polling). Safe for a paused/manual run too.
     */
    cancelRun(statePath: string): void;
    /** Renderer-originated lifecycle stop (terminal closed, blocked, removed…). */
    applyStopReason(push: SprintRuntimeStopReasonPush): void;
    /**
     * The Phase 1 automation service reports every intent write here (before
     * broadcasting to windows) so scheduling reacts immediately: the mode
     * transition runs through the same reducer the renderer uses, and an
     * enabling write wakes the tick loop instead of waiting out the interval.
     */
    notifyAutomationChanged(statePath: string, record: SprintEngineAutomationIntentRecord): void;
    /**
     * Every run the scheduler holds, with whether it is actively auto-running
     * (MC-2156). Read by the background tray, which must answer "what is still
     * going?" with no window open — so it reads the scheduler's own map rather
     * than a renderer projection.
     */
    listRuns(): Array<{
        statePath: string;
        name: string;
        autoRunning: boolean;
    }>;
    /** Introspection for diagnostics/tests. */
    inspectRun(statePath: string): {
        view: SprintEngineWorkspaceView;
        rosterSessions: Record<string, SprintEngineRosterSession>;
    } | null;
    /** Run one scheduler tick immediately (tests; wake paths). */
    tickNow(): Promise<void>;
    shutdown(): void;
};
export type { SprintRuntimeRunRegistration, SprintRuntimeStopReasonPush, SprintRuntimeOp };
