import type React from 'react'
import { useCallback, useMemo } from 'react'

import { conversationWorkingRoot, type AgentState } from '../../../../../shared/agent-state'
import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { Workspace } from '../../../types/workspace'
import type { CliRuntimeOption } from '../../ui/CliModelPicker'
import type { ChatReadiness } from './chatStates'

// What a chat view is bound to besides its transport: the agent fields it reads
// (name, model, preset, mode, skills, the one-shot startup prompt) and where it writes
// them back. A local chat is an agent record in the workspace store; a chat on
// a paired machine has no record here, and keeps the same fields in the pane.

export type ChatAgentFields = Pick<
  AgentState,
  | 'name'
  | 'cliPermissionPreset'
  | 'conversationMode'
  | 'conversationReasoningEffort'
  | 'conversationSkills'
  | 'chatStartupPrompt'
> & { conversation: NonNullable<AgentState['conversation']> }

export type ChatBinding = {
  agent: ChatAgentFields
  update(patch: Partial<ChatAgentFields>): void
  /** The workspace here, for a local chat: its name, folder and other agents. */
  workspace: Workspace | null
  /** This machine's folder the chat works in; null for one on another machine. */
  workspaceRoot: string | null
  /**
   * The root the session subscription is keyed by when it is not the
   * workspace folder: a remote transport names its conversation itself.
   */
  sessionRoot?: string
  /** A readiness decided by the transport (a remote link), in place of this machine's provider check. */
  readiness?: ChatReadiness
  /** The session as the host last listed it, for a transport that does not start one here. */
  session?: ConversationSessionSummary | null
  /** What sits above the transcript in place of the local history title. */
  header?: React.ReactNode
  /** Stamp the sidebar's ordering clock: a sent turn is a user message, as a CLI prompt is. */
  recordUserMessage?(at: number): void
  /** Remember a picked model as the next chat's default. */
  rememberModel?(choice: ChatAgentFields['conversation']): void
  /**
   * The chat's CLI and its models as the machine running the chat lists them,
   * for a chat on another machine. Absent, the picker reads this machine's own
   * catalog for the chat's CLI.
   */
  engine?: CliRuntimeOption
}

/** A local chat's binding: its agent record in the workspace store. Null until that record has a conversation. */
export function useLocalChatBinding(workspaceId: string, agentId: string): ChatBinding | null {
  const agent = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId])
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const recordWorkspaceUserMessage = useWorkspaceStore((s) => s.recordWorkspaceUserMessage)
  const rememberModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const update = useCallback(
    (patch: Partial<ChatAgentFields>) => updateAgent(workspaceId, agentId, patch),
    [updateAgent, workspaceId, agentId],
  )
  const recordUserMessage = useCallback(
    (at: number) => recordWorkspaceUserMessage(workspaceId, at),
    [recordWorkspaceUserMessage, workspaceId],
  )
  return useMemo(
    () =>
      agent?.conversation
        ? {
            agent: agent as ChatAgentFields,
            update,
            workspace,
            // A chat started in a run worktree is keyed by that worktree; the
            // workspace folder would start a second session beside it.
            workspaceRoot: conversationWorkingRoot(agent, workspace?.folderPath),
            recordUserMessage,
            rememberModel,
          }
        : null,
    [agent, update, workspace, recordUserMessage, rememberModel],
  )
}
