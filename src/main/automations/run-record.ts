import type { AutomationRun, AutomationRunStatus } from '../../shared/automations/contracts'

// One completer for every start path. It used to be two: the engine's copy (used
// by the schedule due-run and "Run now") and a near-identical copy inside
// trigger-event-runner.ts that enumerated a shorter field list — it dropped
// `worktreePath`, `branch`, `executionId` and `pullRequestUrl`, and stamped
// `completedAt` on a still-running agent run. A trigger-fired agent therefore
// recorded a run with no branch, so `finalizeRun` opened no pull request and
// removed no worktree: the agent's work stayed on `automations/<runId>` with
// nothing pointing at it. Both paths now share this function, so a field added to
// a run reaches every start path or none.
export function completeAutomationRun(
  run: AutomationRun,
  patch: Partial<AutomationRun>,
  completedAt: string
): AutomationRun {
  const status = patch.status ?? 'completed'
  // An agent-backed run returns `running`: the action launched a long-lived
  // agent and the run stays in-progress (linked to its terminal) until
  // finalizeRun records the real outcome. Non-terminal runs carry no
  // completedAt and emit no terminal run-event.
  return {
    ...run,
    status,
    completedAt: isTerminalRunStatus(status) ? completedAt : null,
    blockedReason: patch.blockedReason,
    workspaceId: patch.workspaceId,
    agentId: patch.agentId,
    executionId: patch.executionId,
    promptFingerprint: patch.promptFingerprint,
    touchedFiles: patch.touchedFiles,
    commandsRan: patch.commandsRan,
    summary: patch.summary,
    isolation: patch.isolation,
    worktreePath: patch.worktreePath,
    branch: patch.branch,
    pullRequestUrl: patch.pullRequestUrl,
  }
}

function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'skipped'
}
