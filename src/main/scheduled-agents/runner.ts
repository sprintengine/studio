// One run of a scheduled agent: what New chat does when someone presses Enter,
// done by main because no window needs to be open. A new workspace in the
// project (on its machine, in a fresh worktree when one was asked for), a chat
// agent in it, and the prompt as its first message. The chat is then an
// ordinary chat — it opens, works and settles like any other — with one field
// more: the id of the scheduled agent that started it, written on its
// workspace. That is what the sidebar marks a run's chat by, what the schedule's
// editor lists its runs by, and what keeps a run from starting while the one
// before it is still working.

import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { agentWorktreePaths } from '../../shared/worktree-paths'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { ScheduledAgent, ScheduledAgentLastRun } from '../../shared/scheduled-agents'
import type { WorkspaceWorktree } from '../../renderer/src/types/workspace'

export type ScheduledAgentRunnerDeps = {
  launchConversation: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
  /** The repository root a folder is in, asked of the machine's own git; null when it is not in one. */
  getRepoRoot: (folderPath: string, hostId: ExecutionHostId | null) => Promise<string | null>
  createWorktree: (input: {
    repoRoot: string
    containerPath: string
    destinationPath: string
    branchName: string
    hostId: ExecutionHostId | null
  }) => Promise<{ ok: true; path: string; branch: string } | { ok: false; message: string }>
  now?: () => number
}

export async function runScheduledAgent(
  agent: ScheduledAgent,
  deps: ScheduledAgentRunnerDeps,
): Promise<ScheduledAgentLastRun> {
  const now = deps.now ?? Date.now
  const at = now()
  let folderPath = agent.folderPath
  let worktree: WorkspaceWorktree | null = null
  if (agent.worktree) {
    const made = await makeRunWorktree(agent, at, deps)
    if (!made.ok) return { at, ok: false, message: made.message }
    folderPath = made.path
    worktree = { branch: made.branch, baseRef: 'HEAD', repoRoot: agent.folderPath }
  }
  const launched = await deps
    .launchConversation({
      newChatIn: { folderPath, hostId: agent.hostId, worktree },
      cli: agent.cli,
      ...(agent.cliModel ? { cliModel: agent.cliModel } : {}),
      ...(agent.permissionPreset ? { permissionPreset: agent.permissionPreset } : {}),
      prompt: agent.prompt,
      ...(agent.skills.length > 0 ? { skills: agent.skills.map((skill) => skill.id) } : {}),
      ...(agent.mcpServers.length > 0 ? { connectorIds: agent.mcpServers.map((server) => server.id) } : {}),
      ...(agent.ownerModuleId ? { ownerModuleId: agent.ownerModuleId } : {}),
      scheduledAgentId: agent.id,
      // A run starts on the schedule's time, not on anyone's request, so it
      // must not take the window from whatever the person is doing; it waits
      // in the list with the schedule's clock on it.
      background: true,
    })
    .catch((error: unknown): ConversationLaunchResult => ({
      ok: false,
      code: 'launch_threw',
      message: error instanceof Error ? error.message : String(error),
    }))
  if (!launched.ok) return { at, ok: false, message: launched.message }
  return { at, ok: true, workspaceId: launched.workspaceId }
}

/**
 * Whether a run's chat is still at work, read off its workspace's conversation
 * sessions: a turn open, or the agent stopped on an approval card. A turn
 * waiting on a person is not finished, and a run started beside it would be
 * doing the same job twice. A chat whose session has gone (settled, the app
 * restarted since) is finished.
 */
export function isRunChatWorking(
  sessions: readonly Pick<ConversationSessionSummary, 'status' | 'turnStartedAt'>[],
): boolean {
  return sessions.some(
    (session) =>
      session.turnStartedAt !== undefined || session.status === 'active' || session.status === 'awaiting_approval',
  )
}

// Each run gets a worktree of its own, named after the one picked and stamped
// with the run's second, so two runs never ask for the same branch — a Run now
// pressed again in the minute a failed run was made in included.
async function makeRunWorktree(
  agent: ScheduledAgent,
  at: number,
  deps: ScheduledAgentRunnerDeps,
): Promise<{ ok: true; path: string; branch: string } | { ok: false; message: string }> {
  const repoRoot = await deps.getRepoRoot(agent.folderPath, agent.hostId).catch(() => null)
  if (!repoRoot) {
    return {
      ok: false,
      message: `${agent.folderPath} is not a git repository, so the run's worktree could not be made.`,
    }
  }
  const base = agent.worktree?.name.trim() || 'scheduled'
  const paths = agentWorktreePaths(repoRoot, `${base}-${runStamp(at)}`)
  if (!paths) return { ok: false, message: `"${base}" does not make a usable worktree name.` }
  const created = await deps.createWorktree({
    repoRoot,
    containerPath: paths.containerPath,
    destinationPath: paths.destinationPath,
    branchName: paths.branchName,
    hostId: agent.hostId,
  })
  return created.ok ? created : { ok: false, message: `The run's worktree could not be made: ${created.message}` }
}

function runStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
