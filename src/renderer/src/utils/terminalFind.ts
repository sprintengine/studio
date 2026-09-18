import { useWorkspaceStore } from '../store/workspaceStore'
import { PANEL_COMMAND_EVENT } from './panelCommands'

/**
 * Which pane answers "Find in Terminal".
 *
 * The command is dispatched at the window (a keystroke through
 * `RendererCommandDispatcher`), and several terminals are mounted at once —
 * the background workspaces' panes stay in the tree. Opening
 * a find bar in all of them would be wrong in a way nobody would see until they
 * switched tabs, so exactly one responds: the pane holding focus, failing that
 * the most recently mounted pane in the active workspace.
 *
 * This is the same shape `AgentChatView`'s model-picker toggle uses, for the
 * same reason: one module-level listener picks the responder, and the panes
 * never compare closures with each other.
 */
export const TERMINAL_FIND_COMMAND = 'terminal.find'

export type MountedTerminalFind = {
  /**
   * The workspace this pane belongs to, or null for a pane that belongs to no
   * workspace (a fleet attachment is to a machine, not a folder). A null entry
   * can still answer — but only by holding focus, never through the
   * active-workspace fallback below, which would otherwise let a remote pane
   * answer for a workspace it is not part of.
   */
  workspaceId: string | null
  /** True while this pane (its terminal or its find bar) holds the keyboard. */
  isFocused: () => boolean
  /** Show the find bar and put the caret in it, keeping any existing query. */
  openFind: () => void
}

const mountedTerminalFinds: MountedTerminalFind[] = []

/**
 * The pane that should answer, or null when none is mounted.
 *
 * `activeWorkspaceId` is read from the store at dispatch time rather than
 * captured, so a pane registered before the user switched workspaces does not
 * answer for the one they are looking at now.
 */
export function respondToTerminalFind(activeWorkspaceId: string | null): MountedTerminalFind | null {
  const responder =
    mountedTerminalFinds.find((entry) => entry.isFocused()) ??
    [...mountedTerminalFinds]
      .reverse()
      .find((entry) => entry.workspaceId !== null && entry.workspaceId === activeWorkspaceId) ??
    null
  responder?.openFind()
  return responder
}

function onTerminalFindPanelCommand(event: Event): void {
  const detail = (event as CustomEvent<{ id?: string }>).detail
  if (detail?.id !== TERMINAL_FIND_COMMAND) return
  respondToTerminalFind(useWorkspaceStore.getState().activeWorkspaceId ?? null)
}

/**
 * Registers a mounted pane as a possible responder; returns the unregister.
 *
 * ONE window listener for the whole app, installed when the first pane mounts
 * and removed when the last unmounts — a listener per pane would run the
 * responder election once per mounted terminal, and an app with no terminal
 * open would leave listeners behind on `window`.
 */
export function registerMountedTerminalFind(entry: MountedTerminalFind): () => void {
  if (mountedTerminalFinds.length === 0) {
    window.addEventListener(PANEL_COMMAND_EVENT, onTerminalFindPanelCommand)
  }
  mountedTerminalFinds.push(entry)
  return () => {
    const index = mountedTerminalFinds.indexOf(entry)
    if (index >= 0) mountedTerminalFinds.splice(index, 1)
    if (mountedTerminalFinds.length === 0) {
      window.removeEventListener(PANEL_COMMAND_EVENT, onTerminalFindPanelCommand)
    }
  }
}

/** Test seam: the responder list is module state, so a test must be able to empty it. */
export function resetMountedTerminalFinds(): void {
  mountedTerminalFinds.length = 0
  window.removeEventListener(PANEL_COMMAND_EVENT, onTerminalFindPanelCommand)
}
