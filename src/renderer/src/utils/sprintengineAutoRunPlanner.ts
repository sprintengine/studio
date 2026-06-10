/**
 * Sprint Engine auto-run planner.
 *
 * The planner answers the question "given the current Sprint Engine state +
 * dispatch state + concurrency limits, what should the supervisor try to do
 * next?" — it is pure with respect to side effects: every input arrives as a
 * value, and every output is data the supervisor or executor can act on.
 *
 * No `window.api`, no React, no Zustand store mutation. The supervisor (and
 * its eventual `sprintengineAutoRunExecutor.ts` sibling) own all IPC and
 * store-update side effects.
 *
 * This module is currently a thin canonical re-export of the planner symbols
 * that historically lived in `sprintengineAutoRun.ts`. Keeping the
 * implementations there preserves the existing `sprintengineAutoRun.test.ts`
 * imports without breakage; new code should import from this module and the
 * underlying implementations can migrate here over time.
 */

export {
  AUTO_RUN_ROLE_CONTINUATION_GRACE_MS,
  AGENT_COMPLETION_NOTIFICATION_KINDS,
  NEEDS_INPUT_AUTO_APPROVAL_STATUSES,
  agentNotificationDeliveryKey,
  architectTriageMessageKey,
  artifactApprovalMessageKey,
  buildAgentNotificationPrompt,
  buildArchitectNeedsInputTriagePrompt,
  buildSprintEngineContinuationPrompt,
  buildSprintEngineDispatchPrompt,
  buildSprintEngineGateContinuationPrompt,
  continuationMessageKey,
  describeNeedsInputAutoApprovalState,
  getActiveSprintEngineAutoRunGateClaims,
  getArchitectActionableNeedsInputTasks,
  getAutoApprovalIntentArtifacts,
  getClaimableSprintEngineAutoRunGates,
  getPendingAgentNotificationEvents,
  getSprintEngineAutoRunOccupiedAgentIds,
  isAgentNotificationCompletionEvent,
  isSprintEngineAutoPendingSpawnStillRelevant,
  isSprintEngineRunBlockedOnExternalInput,
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
  sprintEngineAutoRunWorkKey,
  sprintEngineDispatchDeliveryKey,
} from './sprintengineAutoRun'

export type {
  AutoRunCandidate,
  PickNextAutoRunsOptions,
  RoleContinuationGrace,
  SprintEngineAutoRunActiveGateClaim,
  SprintEngineBootstrapDecision,
} from './sprintengineAutoRun'
