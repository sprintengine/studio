/**
 * Resume in terminal: a chat's conversation carried on by a terminal agent.
 *
 * A Claude or Codex chat runs the person's own CLI through its SDK or app
 * server, in the chat's folder, with the CLI's own config home, so the session
 * it keeps is one the CLI can resume: `claude --resume <id>` and
 * `codex resume <id>` open the very conversation the chat was having. This is
 * the one place that hands it over, in order:
 *
 * 1. Ask the chat for its CLI session, refused while its next turn would fork
 *    at an earlier point (Edit from here) or while it has no session yet.
 * 2. Stop whatever the chat is running, as its Stop button would: the turn is
 *    interrupted, a card it waits on is answered no, and agents it started end
 *    with its child. Then suspend it, so the child is gone before the terminal
 *    opens the session: two processes writing one session would branch it.
 * 3. Launch a terminal agent on the same CLI, folder and machine that resumes
 *    the session.
 * 4. Tell the chat where its conversation went, and what was stopped for it.
 *
 * Handing over a working chat stops its agent rather than refusing: the
 * person asked for the conversation in a terminal, and waiting out a long turn
 * was otherwise the only way to get it there.
 *
 * The chat is only suspended, never ended. It can be typed into again; its
 * next message resumes the same CLI session, terminal turns and all, which is
 * what the notice says.
 */
import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import type { CliPermissionPreset } from '../shared/cli-permission-preset'
import { CONVERSATION_DEFAULT_MODEL_ID, cliForConversationProvider } from '../shared/conversation-harness'
import type {
  ConversationTerminalHandoffInput,
  ConversationTerminalHandoffResult,
} from '../shared/conversation-runtime'
import { normalizeExecutionHostId } from '../shared/execution-host'
import type { ConversationTerminalHandoffTarget } from './conversation-runtime'

export type ConversationTerminalHandoffDeps = {
  runtime: {
    terminalHandoffTarget: (
      input: ConversationTerminalHandoffInput,
    ) => Promise<{ ok: true; target: ConversationTerminalHandoffTarget } | { ok: false; message: string }>
    stopForTerminalHandoff: (
      input: ConversationTerminalHandoffInput,
    ) => Promise<{ ok: true; stopped: TerminalHandoffStopped } | { ok: false; message: string }>
    endTerminalHandoff: (input: ConversationTerminalHandoffInput) => void
    noteTerminalHandoff: (input: { sessionId: string; notice: string }) => Promise<void>
  }
  launch: (request: AgentLaunchRequest) => Promise<AgentLaunchResult>
  /** Whether the CLI's manifest declares a verified resume (`capabilities.resumeSession`). */
  cliResumesSessions: (cli: string) => boolean
  /** The presets a terminal launch of the CLI is told in its own words, or null when unknown. */
  permissionPresetsForCli?: (cli: string) => readonly CliPermissionPreset[] | null
  /** The chat's own name in its workspace, which the terminal agent is named after. */
  chatName?: (workspaceId: string, agentId: string) => string | null | undefined
}

export function createConversationTerminalHandoff(deps: ConversationTerminalHandoffDeps) {
  async function handoff(input: ConversationTerminalHandoffInput): Promise<ConversationTerminalHandoffResult> {
    const found = await deps.runtime.terminalHandoffTarget(input)
    if (!found.ok) return found
    const { target } = found
    const cli = cliForConversationProvider(target.providerId)
    if (!cli || !deps.cliResumesSessions(cli))
      return { ok: false, message: 'A terminal cannot resume this kind of chat yet.' }

    try {
      const stopped = await deps.runtime.stopForTerminalHandoff({ sessionId: input.sessionId })
      if (!stopped.ok) return { ok: false, message: stopped.message }

      const launched = await deps.launch(
        terminalLaunchRequest(target, cli, {
          terminalPresets: deps.permissionPresetsForCli?.(cli) ?? null,
          chatName: deps.chatName?.(target.workspaceId, target.agentId) ?? null,
        }),
      )
      // The chat is only suspended: its next message resumes the session as
      // though nothing had happened.
      if (!launched.ok) return { ok: false, message: launched.message }

      await deps.runtime.noteTerminalHandoff({ sessionId: input.sessionId, notice: handoffNotice(stopped.stopped) })
      return { ok: true, workspaceId: launched.workspaceId, agentId: launched.agentId }
    } finally {
      deps.runtime.endTerminalHandoff({ sessionId: input.sessionId })
    }
  }

  return { handoff }
}

/**
 * The terminal launch that resumes a chat: the chat's CLI, folder, machine and
 * permission mode (where the CLI has that mode in a terminal), resuming its
 * session. The chat's model rides along for the tab's model chip; a CLI's
 * resume command keeps the model its session was on.
 */
export function terminalLaunchRequest(
  target: ConversationTerminalHandoffTarget,
  cli: string,
  { terminalPresets, chatName }: { terminalPresets: readonly CliPermissionPreset[] | null; chatName: string | null },
): AgentLaunchRequest {
  const host = normalizeExecutionHostId(target.cliRuntimes?.[cli]?.hostId)
  const preset =
    target.permissionPreset && (!terminalPresets || terminalPresets.includes(target.permissionPreset))
      ? target.permissionPreset
      : undefined
  const model = target.modelId && target.modelId !== CONVERSATION_DEFAULT_MODEL_ID ? target.modelId : undefined
  return {
    workspaceId: target.workspaceId,
    cli,
    cwd: target.workspaceRoot,
    resumeCliSessionId: target.providerSessionId,
    ...(chatName?.trim() ? { name: `${chatName.trim()} (terminal)` } : {}),
    ...(host ? { host } : {}),
    ...(preset ? { permissionPreset: preset } : {}),
    ...(model ? { cliModel: model } : {}),
  }
}

/** What a handoff stopped in the chat: its turn (or the card it waited on), and the agents it had started. */
export type TerminalHandoffStopped = { turn: boolean; agents: number }

/**
 * The chat's note on where it went. A turn or agent the handoff stopped is
 * named, since the terminal resumes the session where it was cut off and
 * starts none of it again.
 */
export function handoffNotice(stopped: TerminalHandoffStopped): string {
  const after = 'A message sent here picks it up from wherever the terminal leaves it.'
  const agents = stopped.agents === 1 ? 'the agent it started' : `the ${stopped.agents} agents it started`
  const what =
    stopped.turn && stopped.agents > 0
      ? `The agent was stopped, with ${agents}, so this conversation could continue in a terminal.`
      : stopped.agents > 0
        ? `${stopped.agents === 1 ? 'The agent this chat started was' : `The ${stopped.agents} agents this chat started were`} stopped, so this conversation could continue in a terminal.`
        : stopped.turn
          ? 'The agent was stopped, so this conversation could continue in a terminal.'
          : 'This conversation continues in a terminal.'
  return `${what} ${after}`
}
