import { agentCliSupportsConversationResume, resumeCapabilitiesForCli } from '../../../../../shared/agent-cli-resume'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import type { PluginRegistryListEntry } from '../../../../../shared/plugin-manifest'
import { showToast } from '../../../store/toastStore'
import type { AgentState } from '../../../types/workspace'
import { clientSupports } from '../../../clientCapabilities'
import { ensureChatWorktree } from '../../../utils/chatWorktreeRestore'

/**
 * Resume in terminal, the renderer's half: offered for a chat whose CLI resumes
 * a session in a terminal (Claude Code and Codex today; the manifest's
 * `capabilities.resumeSession` turns others on), and carried out by main,
 * which stops whatever the chat is running (as its Stop button would),
 * suspends it and launches the terminal agent. So it is offered mid-turn too,
 * with nothing to confirm, as Stop has nothing. The new tab is revealed as
 * every main-launched agent's is.
 */
export function chatResumesInTerminal(
  agent: Pick<AgentState, 'runtimeKind' | 'conversation'> | undefined,
  catalog: readonly PluginRegistryListEntry[],
): boolean {
  if (agent?.runtimeKind !== 'conversation') return false
  // A shell with no terminals (a browser tab) has nowhere to resume it.
  if (!clientSupports('terminals')) return false
  const cli = cliForConversationProvider(agent.conversation?.providerId)
  return cli !== null && agentCliSupportsConversationResume(resumeCapabilitiesForCli(cli, catalog))
}

export async function resumeChatInTerminal(input: {
  workspaceId: string
  agentId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  // A chat whose worktree the cleanup gave back gets it back first, as the
  // open chat does before it starts anything: from a tab's menu nothing else
  // has, and main would start the session in a folder that is not there (or,
  // for a pool slot, someone else's).
  if (!(await ensureChatWorktree(input.workspaceId)))
    return { ok: false, message: 'This chat’s worktree could not be brought back, so nothing can run in it.' }
  // By the chat's identity: main hands over the session it is running, or,
  // for a chat not sent anything since the app started, starts one to read
  // the CLI session from its transcript.
  const result = await window.api.conversationSessionTerminalHandoff({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  })
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}

/** For a menu or a palette command, which has nowhere of its own to say why it could not. */
export async function resumeChatInTerminalOrToast(input: { workspaceId: string; agentId: string }): Promise<void> {
  const result = await resumeChatInTerminal(input).catch((error: unknown): { ok: false; message: string } => ({
    ok: false,
    message: error instanceof Error ? error.message : 'The chat could not be continued in a terminal.',
  }))
  if (!result.ok) showToast({ tone: 'error', title: 'Could not continue in a terminal', description: result.message })
}
