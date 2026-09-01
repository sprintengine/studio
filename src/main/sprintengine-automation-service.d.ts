import type { DiagnosticLogInput, SprintEngineAutomationChangedEvent, SprintEngineAutomationReadResult, SprintEngineAutomationWriteResult } from '../shared/electron-api';
import type { SprintEngineAutomationMode, SprintEngineCliPermissionPreset } from '../shared/sprintengine/automation-types';
import { type SprintEngineAutomationIntentActor, type SprintEngineAutomationIntentRecord, type SprintEngineAutomationRuntimeResidue } from '../shared/sprintengine/automation-intent';
export type { SprintEngineAutomationChangedEvent };
export type SetSprintEngineAutomationModeInput = {
    statePath: string;
    mode: SprintEngineAutomationMode;
    actor: SprintEngineAutomationIntentActor;
    deviceId?: string | null;
    clientToken?: string;
    reason?: string;
    details?: string;
    suppressManualAudit?: boolean;
    workspaceId?: string;
    workspaceName?: string;
    taskId?: string;
    agentId?: string;
};
export type SetSprintEngineCliPermissionPresetInput = {
    statePath: string;
    preset: SprintEngineCliPermissionPreset;
    actor: SprintEngineAutomationIntentActor;
    clientToken?: string;
};
export type SprintEngineAutomationServiceDeps = {
    setRunnerCliWatchPolling: (input: {
        statePath: string;
        cliWatchPolling: 'enabled' | 'disabled';
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    logDiagnostic: (input: DiagnosticLogInput) => void;
    broadcast: (event: SprintEngineAutomationChangedEvent) => void;
    /**
     * Called when `hydrateAutomationMode` seeds a sidecar (first write). The
     * hydration deliberately does not `broadcast` to windows (the seeding
     * renderer already holds the value), but the main scheduler still has to
     * adopt the now-authoritative mode — without this a freshly created run
     * would sit at `manual` in the scheduler until an explicit mode toggle.
     */
    notifyHydrated?: (statePath: string, record: SprintEngineAutomationIntentRecord) => void;
    now?: () => number;
};
export type SprintEngineAutomationService = ReturnType<typeof createSprintEngineAutomationService>;
export declare function createSprintEngineAutomationService(deps: SprintEngineAutomationServiceDeps): {
    readAutomationMode(input: {
        statePath: string;
    }): Promise<SprintEngineAutomationReadResult>;
    setAutomationMode(input: SetSprintEngineAutomationModeInput): Promise<SprintEngineAutomationWriteResult>;
    /**
     * The CLI permission preset agents spawn with (MC-1799), keyed by statePath
     * like the mode — the Sprints door must be able to set it with no resident
     * workspace, which the workspace-keyed store action could not do.
     *
     * Shares the mode's queue, revision counter and broadcast: both live in one
     * record, so a preset write is a new revision of the same intent.
     */
    setCliPermissionPreset(input: SetSprintEngineCliPermissionPresetInput): Promise<SprintEngineAutomationWriteResult>;
    /**
     * Scheduler bookkeeping persistence (Phase 3): merge the runtime residue
     * into the record WITHOUT bumping the revision, auditing, bridging, or
     * broadcasting — it is durable bookkeeping beside the intent, not a
     * transition. No-ops when no intent record exists yet (the residue is
     * meaningless before the run's mode has ever been written/hydrated).
     */
    updateRuntimeResidue(input: {
        statePath: string;
        runtime: SprintEngineAutomationRuntimeResidue;
    }): Promise<void>;
    /**
     * One-time migration seam: seed the sidecar from the legacy renderer-owned
     * value, only when no sidecar exists yet. No audit (nothing transitioned),
     * no cliWatchPolling bridge (run.yaml already reflects the old UI's own
     * writes), no broadcast (the seeding renderer already holds this value and
     * a fresh window reads before hydrating).
     *
     * When a sidecar already exists the returned record is main's, carrying
     * whatever `cliPermissionPreset` was persisted — that is how a workspace
     * attaching after a door-mount preset write picks it back up.
     */
    hydrateAutomationMode(input: {
        statePath: string;
        mode: SprintEngineAutomationMode;
    }): Promise<SprintEngineAutomationWriteResult>;
};
