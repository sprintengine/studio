import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { workspaceProjectRootOf } from '../../../../../shared/worktree-paths'
import type { WorkspaceId, WorkspaceWorktree } from '../../../types/workspace'
import type { NewChatWorktreeResult, PendingNewChatWorktree } from '../../../utils/newChatWorktree'
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
  extension?: NewChatExtension
  /** A chat's staged images, sent as images with `startupPrompt`. */
  startupImages?: string[]
  /** A chat's files attached by path, sent as its first message's `files`. */
  startupFiles?: string[]
  /** ⌘⏎: the chat starts out of sight and New chat stays up for the next one. */
  background?: boolean
  /** The machine New chat stands on, which makes a worktree too. */
  hostId?: ExecutionHostId | null
}

/**
 * The extension a chat starts by making: its id, and the folder the person
 * picked for it — absent, it gets a new folder of its own in the extensions
 * home.
 */
export type NewChatExtension = { id: string; folder?: string }

export type NewChatConfirmHost = {
  /** The extension's own folder, made or found, or null after saying why. */
  makeExtension: (extension: NewChatExtension, startupPrompt: string) => Promise<string | null>
  makeWorktree: (scopedFolder: string | null, requestedName: string) => Promise<NewChatWorktreeResult>
  startTerminal: (folderPath: string | null, background?: boolean) => WorkspaceId | null
  startGeneral: (
    confirm: Extract<AgentComposerConfirm, { kind: 'general' }>,
    folderPath: string | null,
    startupPrompt: string | undefined,
    worktree: WorkspaceWorktree | undefined,
    background?: boolean,
    /** Opened before its worktree: no folder yet, and this on its agent, whose terminal waits on it. */
    pendingWorktree?: PendingNewChatWorktree,
  ) => WorkspaceId | null
  startConversation: (
    confirm: Extract<AgentComposerConfirm, { kind: 'conversation' }>,
    folderPath: string | null,
    startupPrompt: string | undefined,
    worktree: WorkspaceWorktree | undefined,
    startupImages: string[] | undefined,
    startupFiles: string[] | undefined,
    background?: boolean,
    /** Opened before its worktree: no folder yet, and this on its agent. */
    pendingWorktree?: PendingNewChatWorktree,
  ) => WorkspaceId | null
  /** Make the worktree a chat opened with `pendingWorktree` is waiting on. */
  prepareWorktree: (workspaceId: WorkspaceId) => void
  /**
   * Name a chat after its first message before that message is sent, as the
   * send itself would (store/generatedWorkspaceTitle.ts): the heuristic title
   * at once, which locks the name, and the model-written one when it comes.
   */
  titleFromPrompt: (workspaceId: WorkspaceId, prompt: string) => void
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
  // An agent asked for a worktree opens at once, before the worktree exists:
  // the seconds the worktree takes are spent in the chat, which says what it is
  // waiting on, not on New chat with nothing moving. It has no folder until the
  // worktree lands, so nothing in it can start in the checkout the person asked
  // to keep clean (utils/newChatWorktree.ts). A chat agent shows its prompt
  // waiting; a terminal agent's pane holds its launch, prompt and all, until
  // the folder is there (TerminalView).
  if (
    !extension &&
    (confirm.kind === 'conversation' || confirm.kind === 'general') &&
    confirm.worktree &&
    scopedFolder
  ) {
    const projectFolder = workspaceProjectRootOf({ folderPath: scopedFolder }) ?? scopedFolder
    const pending: PendingNewChatWorktree = {
      name: confirm.worktree.name,
      projectFolder,
      ...(request.hostId ? { hostId: request.hostId } : {}),
    }
    const created =
      confirm.kind === 'conversation'
        ? host.startConversation(
            confirm,
            null,
            startupPrompt,
            { repoRoot: projectFolder },
            startupImages,
            startupFiles,
            background,
            pending,
          )
        : // A terminal agent's prompt rides the record too: its own startup
          // prompt is not kept across a restart, and the record is.
          host.startGeneral(
            confirm,
            null,
            startupPrompt,
            { repoRoot: projectFolder },
            background,
            startupPrompt?.trim() ? { ...pending, prompt: startupPrompt } : pending,
          )
    if (created) {
      host.prepareWorktree(created)
      host.recordProjectUse(projectFolder)
      // Its message waits on the worktree, so the chat is named from it now
      // rather than reading "Chat" in the header and the sidebar until it is
      // sent. The name is locked by it, so the send names nothing again; a
      // terminal agent's first prompt, heard from its CLI, finds it named.
      if (startupPrompt?.trim()) host.titleFromPrompt(created, startupPrompt)
    }
    if (!background) host.closePanel()
    return created
  }
  // An agent asked for a worktree starts IN it: the folder becomes the
  // worktree and the marker rides along. A worktree that cannot be made
  // leaves the door open with the diagnostic, never a chat in the checkout.
  let folderPath = scopedFolder
  let worktree: WorkspaceWorktree | undefined
  // An extension starts in a folder of its own — the one picked, or a new one
  // in the extensions home — made from the SDK's template before the chat
  // (which needs the skill the scaffold puts there). One already holding an
  // extension is carried on as it is. A project that cannot be made leaves
  // the door open, with why. The door's project plays no part.
  if (extension) {
    const made = await host.makeExtension(extension, startupPrompt ?? '')
    if (!made) return null
    folderPath = made
  } else if ((confirm.kind === 'general' || confirm.kind === 'conversation') && confirm.worktree) {
    // Only without a project to cut it from, which the worktree refuses with why.
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
  // checkout its worktree was cut from, and for an extension its own folder,
  // so the pickers offer it the next time.
  const usedFolder = worktree?.repoRoot ?? (extension ? folderPath : scopedFolder)
  if (created && usedFolder) host.recordProjectUse(usedFolder)
  // ⌘⏎ stays on New chat; the panel empties itself for the next one.
  if (!background) host.closePanel()
  return created
}
