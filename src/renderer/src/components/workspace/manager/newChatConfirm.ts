import type { WorkspaceId, WorkspaceWorktree } from '../../../types/workspace'
import type { NewChatWorktreeResult } from '../../../utils/newChatWorktree'
import type { AgentComposerConfirm } from '../agentComposer/useAgentComposer'

// What the New chat door's confirm does once the machine it stands on is
// known: make the folder the chat needs (an extension's project, a worktree),
// start the kind of chat that was picked, count it as a use of its project,
// and close the door unless ⌘⏎ asked to stay.
//
// Store-free, so every kind is tested without a window: WorkspaceManager hands
// in the starts, which persist the remembered pick and seed the solo workspace.

export type NewChatConfirmRequest = {
  confirm: AgentComposerConfirm
  /** The project the door was scoped to, or the one its selector picked. */
  scopedFolder: string | null
  startupPrompt?: string
  extension?: { id: string }
  /** A chat's staged images, sent as images with `startupPrompt`. */
  startupImages?: string[]
  /** A chat's files attached by path, sent as its first message's `files`. */
  startupFiles?: string[]
  /** ⌘⏎: the chat starts out of sight and New chat stays up for the next one. */
  background?: boolean
}

export type NewChatConfirmHost = {
  /** The extension's own folder inside the project, or null after saying why. */
  makeExtension: (parentDir: string, id: string, startupPrompt: string) => Promise<string | null>
  makeWorktree: (scopedFolder: string | null, requestedName: string) => Promise<NewChatWorktreeResult>
  startTerminal: (folderPath: string | null, background?: boolean) => WorkspaceId | null
  startGeneral: (
    confirm: Extract<AgentComposerConfirm, { kind: 'general' }>,
    folderPath: string | null,
    startupPrompt: string | undefined,
    worktree: WorkspaceWorktree | undefined,
    background?: boolean,
  ) => WorkspaceId | null
  startConversation: (
    confirm: Extract<AgentComposerConfirm, { kind: 'conversation' }>,
    folderPath: string | null,
    startupPrompt: string | undefined,
    worktree: WorkspaceWorktree | undefined,
    startupImages: string[] | undefined,
    startupFiles: string[] | undefined,
    background?: boolean,
  ) => WorkspaceId | null
  /** A use of the project, which the project pickers order by (shared/project-frecency.ts). */
  recordProjectUse: (folderPath: string) => void
  closePanel: () => void
}

/** Answers the chat it created, or null when it created none (each refusal says why). */
export async function confirmNewChatWith(
  host: NewChatConfirmHost,
  request: NewChatConfirmRequest,
): Promise<WorkspaceId | null> {
  const { confirm, scopedFolder, startupPrompt, extension, startupImages, startupFiles, background } = request
  // An agent asked for a worktree starts IN it: the folder becomes the
  // worktree and the marker rides along. A worktree that cannot be made
  // leaves the door open with the diagnostic, never a chat in the checkout.
  let folderPath = scopedFolder
  let worktree: WorkspaceWorktree | undefined
  // An extension starts in a folder of its own inside the project, made from
  // the SDK's template before the chat (which needs the skill the scaffold
  // puts there). One already holding an extension is carried on as it is. A
  // project that cannot be made leaves the door open, with why.
  if (extension) {
    if (!scopedFolder) return null
    const made = await host.makeExtension(scopedFolder, extension.id, startupPrompt ?? '')
    if (!made) return null
    folderPath = made
  } else if ((confirm.kind === 'general' || confirm.kind === 'conversation') && confirm.worktree) {
    const made = await host.makeWorktree(scopedFolder, confirm.worktree.name)
    if (!made.ok) return null
    folderPath = made.folderPath
    worktree = made.worktree
  }
  let created: WorkspaceId | null = null
  switch (confirm.kind) {
    case 'terminal':
      created = host.startTerminal(folderPath, background)
      break
    // MCP picks were synced into the workspace's CLI config on pick
    // (SkillsAndMcpsPicker), so the spawn has nothing to route: the agent
    // starts in the workspace and finds them there.
    case 'general':
      created = host.startGeneral(confirm, folderPath, startupPrompt, worktree, background)
      break
    case 'conversation':
      created = host.startConversation(
        confirm,
        folderPath,
        startupPrompt,
        worktree,
        startupImages,
        startupFiles,
        background,
      )
      break
  }
  // Every chat started here is a use of its project, whatever kind it is: the
  // folder the picker offered, which for a chat with Worktree on is the
  // checkout its worktree was cut from, and for an extension the project it
  // was made inside.
  const usedFolder = worktree?.repoRoot ?? scopedFolder
  if (created && usedFolder) host.recordProjectUse(usedFolder)
  // ⌘⏎ stays on New chat; the panel empties itself for the next one.
  if (!background) host.closePanel()
  return created
}
