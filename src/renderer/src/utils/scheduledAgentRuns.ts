// A scheduled agent's runs, as a window reads them. Each run is an ordinary
// chat whose workspace carries the schedule's id (`Workspace.scheduledAgentId`),
// so the chats themselves are the record of the runs: the sidebar marks them,
// the schedule's editor lists them, and the schedule's own row says what its
// latest run is doing without pretending to be that run.

import type { Workspace, WorkspaceId } from '../types/workspace'
import type { ScheduledAgentView } from '../../../shared/scheduled-agents'

type RunActivity = 'needs-input' | 'working' | 'failed' | 'idle'
type ActivityByWorkspaceId = Readonly<Record<WorkspaceId, RunActivity | undefined>>

/** How many of a schedule's runs its editor lists: the recent ones, not a history. */
export const SCHEDULED_RUNS_LISTED = 5

/** A chat a schedule started, which the sidebar marks with the schedule's clock. */
export function isScheduledRunChat<W extends Pick<Workspace, 'scheduledAgentId'>>(
  workspace: W,
): workspace is W & { scheduledAgentId: string } {
  return typeof workspace.scheduledAgentId === 'string' && workspace.scheduledAgentId.trim().length > 0
}

export type ScheduledRunEntry = {
  workspaceId: WorkspaceId
  title: string
  startedAt: number
  activity: RunActivity
}

/**
 * The chats a schedule started that are still open here, newest first, at
 * most `limit`. A closed chat is gone from the list as it is gone from the
 * sidebar; a settled one is still a chat, and opening it resumes it.
 */
export function scheduledAgentRuns(
  workspaces: readonly Pick<Workspace, 'id' | 'name' | 'createdAt' | 'scheduledAgentId'>[],
  scheduledAgentId: string,
  activityByWorkspaceId: ActivityByWorkspaceId,
  limit = SCHEDULED_RUNS_LISTED,
): ScheduledRunEntry[] {
  return workspaces
    .filter((workspace) => workspace.scheduledAgentId === scheduledAgentId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, limit))
    .map((workspace) => ({
      workspaceId: workspace.id,
      title: workspace.name,
      startedAt: workspace.createdAt,
      activity: activityByWorkspaceId[workspace.id] ?? 'idle',
    }))
}

/**
 * Whether the schedule's latest run is still going, as its row says it: in
 * progress, or stopped on a question for the person. The latest run only —
 * the same one main asks about before starting another — and null when that
 * run did not start a chat, or its chat has finished.
 */
export function scheduledAgentRunInProgress(
  agent: Pick<ScheduledAgentView, 'lastRun'>,
  activityByWorkspaceId: ActivityByWorkspaceId,
): 'working' | 'needs-input' | null {
  const workspaceId = agent.lastRun?.ok ? agent.lastRun.workspaceId : null
  if (!workspaceId) return null
  const activity = activityByWorkspaceId[workspaceId]
  return activity === 'working' || activity === 'needs-input' ? activity : null
}
