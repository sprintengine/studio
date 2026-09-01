import { SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, type AutomationTriggerProvider, type SprintEngineRunCompletedTriggerConfig, type SprintEngineRunNeedsInputTriggerConfig } from '../../../shared/automations/contracts';
import type { SprintEngineState } from '../../../shared/sprintengine/run-types';
import { type SprintEngineAutomationFrontDoors } from '../actions/sprint-engine';
export { SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, };
export type { SprintEngineRunCompletedTriggerConfig, SprintEngineRunNeedsInputTriggerConfig };
export declare const COMPLETED_CONFIRMATION_MS: number;
type ValidatedConfig<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: string;
};
/**
 * Stable identity of a RUN INSTANCE, used to key event dedupe so a
 * delete-and-recreate of the team dir fires again (MC-1438's rule) while task
 * updates within one run keep the same fingerprint.
 *
 * `SprintEngineState` has no run-created stamp of its own (`updatedAt` mutates
 * constantly and must never be used). The stable field is on the projection:
 * `creation.createdAt`, written by the folder store at run creation — but it is
 * OPTIONAL. So: hash `creation.createdAt` when present, else fall back to
 * `name + goal`. Documented tradeoff: a recreated run with an identical name+goal
 * and no creation stamp dedupes against its predecessor — accepted rather than
 * inventing state. A leading discriminant keeps the two branches from ever
 * colliding (a name that happens to equal some other run's createdAt string).
 */
export declare function sprintEngineRunFingerprint(state: Pick<SprintEngineState, 'creation' | 'name' | 'goal'>): string;
/**
 * `sprint-engine.run-completed` — fires ONCE per finished run instance. Predicate:
 * `isCompletedSprintEngineRun` (≥1 task and every task done) AND NOT
 * `isCanceledSprintEngineRun` (a canceled run is decided, not finished). The
 * completion must HOLD across `COMPLETED_CONFIRMATION_MS` before it fires, so a
 * transient all-done during incremental planning cannot burn the dedupe id (see
 * that constant). Event id `sprint-completed:<team>:<fingerprint>`, so the
 * engine's persisted dedupe makes every later poll a no-op while a recreated run
 * (new fingerprint) fires again.
 */
export declare function createSprintEngineRunCompletedTriggerProvider(frontDoors: Pick<SprintEngineAutomationFrontDoors, 'readProjection'>): AutomationTriggerProvider;
/**
 * `sprint-engine.run-needs-input` — fires one event PER TASK blocked on a human
 * (`status === 'needs_input' && needsInput.kind === 'user'`, via
 * `sprintEngineHumanInputTasks`; architect-routed questions are deliberately
 * excluded because the engine can triage those itself). Skips entirely when the
 * run is canceled or completed. Event id
 * `sprint-needs-input:<team>:<fingerprint>:<taskId>:<reportedAt>`, so a task that
 * re-blocks later (new `reportedAt`) fires again while a redelivery of the same
 * blocker dedupes.
 *
 * `needsInput.reportedAt` is OPTIONAL: when a blocked task carries none, the id
 * uses the literal token `unreported`. Consequence: if the SAME task re-blocks
 * and again omits `reportedAt`, that re-block dedupes against the first instead
 * of refiring — accepted, because without a report timestamp there is no signal
 * to distinguish the two blocks.
 *
 * The payload carries everything a steward needs to answer via
 * `sprint.task.resolve_input` without a projection read of its own.
 */
export declare function createSprintEngineRunNeedsInputTriggerProvider(frontDoors: Pick<SprintEngineAutomationFrontDoors, 'readProjection'>): AutomationTriggerProvider;
export declare function validateSprintEngineRunNeedsInputTriggerConfig(config: unknown): ValidatedConfig<SprintEngineRunNeedsInputTriggerConfig>;
export declare function validateSprintEngineRunCompletedTriggerConfig(config: unknown): ValidatedConfig<SprintEngineRunCompletedTriggerConfig>;
