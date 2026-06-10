import type { Workspace, WorkspaceId } from '../../types/workspace'
import { isSprintEngineCompletionUnseen } from '../../utils/workspaceRunGlyph'

type CompletionAcknowledgementWorkspace = Pick<
  Workspace,
  'id' | 'mode' | 'sprintEngineState' | 'sprintEngineContext' | 'sprintEngineAutoState'
>

export function acknowledgeActiveSprintEngineCompletion(input: {
  activeWorkspaceId: WorkspaceId | null
  workspaces: CompletionAcknowledgementWorkspace[]
  markSprintEngineRunCompletionSeen: (workspaceId: WorkspaceId, seenAt?: number) => void
  seenAt?: number
}): boolean {
  if (!input.activeWorkspaceId) return false
  const workspace = input.workspaces.find((candidate) => candidate.id === input.activeWorkspaceId)
  if (!workspace || !isSprintEngineCompletionUnseen(workspace)) return false
  input.markSprintEngineRunCompletionSeen(workspace.id, input.seenAt)
  return true
}
