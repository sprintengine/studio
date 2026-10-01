import { agentCliSupportsConversationResume, resumeCapabilitiesForCli } from '../../../../../shared/agent-cli-resume'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import type { PluginRegistryListEntry } from '../../../../../shared/plugin-manifest'
import { showToast } from '../../../store/toastStore'
import type { AgentState } from '../../../types/workspace'

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
  const cli = cliForConversationProvider(agent.conversation?.providerId)
  return cli !== null && agentCliSupportsConversationResume(resumeCapabilitiesForCli(cli, catalog))
}

export async function resumeChatInTerminal(input: {
  workspaceId: string
  agentId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const listed = await window.api.conversationSessionsList({ workspaceId: input.workspaceId, agentId: input.agentId })
  // The chat's current session: the one its next message would go to.
  const session = listed.ok
    ? listed.sessions.filter((candidate) => candidate.status !== 'stopped').sort((a, b) => b.updatedAt - a.updatedAt)[0]
    : undefined
  if (!session) return { ok: false, message: 'This chat has no CLI session yet. Send it a message first.' }
  const result = await window.api.conversationSessionTerminalHandoff({ sessionId: session.sessionId })
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
