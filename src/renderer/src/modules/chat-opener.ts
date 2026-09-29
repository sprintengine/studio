import type { ModuleOpenChatInput, ModuleOpenChatResult } from '../../../shared/modules/conversation-service'

// The port behind `RendererHost.openChat`. The kernel is created at import,
// before any window has a workspace store to open a chat in, so the shell that
// owns that store registers the opener here once it mounts and clears it when
// it unmounts. Until then there is nothing to open a chat with, and openChat
// answers `unavailable`.
export type WorkspaceChatOpener = (input: ModuleOpenChatInput & { moduleId: string }) => Promise<ModuleOpenChatResult>

let workspaceChatOpener: WorkspaceChatOpener | null = null

export function setWorkspaceChatOpener(fn: WorkspaceChatOpener | null): void {
  workspaceChatOpener = fn
}

export function getWorkspaceChatOpener(): WorkspaceChatOpener | null {
  return workspaceChatOpener
}
