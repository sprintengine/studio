import { useWorkspaceStore } from '../store/workspaceStore'
import { PANEL_COMMAND_EVENT } from './panelCommands'

/**
 * Which pane answers "Jump to Previous/Next Prompt".
 *
 * The commands are dispatched at the window (a keystroke through
 * `RendererCommandDispatcher`) and several terminals are mounted at once, so
 * exactly one pane responds: the one holding focus, failing that the most
 * recently mounted pane in the active workspace. That is the same election
 * `terminalFind.ts` runs, and deliberately the same shape — a find bar that
 * opened in one pane while the prompt jump moved another would be a bug nobody
 * could describe.
 *
 * A SIBLING list rather than a field on the find entry, because the two are
 * registered by different owners at different times: `useTerminalFind` owns the
 * find bar and registers from the hook, while prompt navigation belongs to the
 * pane's terminal and its OSC 133 marks and registers from the mount effect
 * that builds them. Folding one into the other would tie a hook's lifecycle to
 * a terminal's.
 *
 * Only `shell` panes register. An agent pane runs a CLI rather than a prompt
 * and is never sent the shell integration that emits the marks; a fleet pane is
 * attached to another machine's terminal, which we do not inject into either.
 */
export const TERMINAL_PROMPT_PREVIOUS_COMMAND = 'terminal.promptPrevious'
export const TERMINAL_PROMPT_NEXT_COMMAND = 'terminal.promptNext'

export type TerminalPromptDirection = 'previous' | 'next'

export type MountedTerminalPromptNavigation = {
  /** The workspace this pane belongs to; null panes answer only by holding focus. */
  workspaceId: string | null
  /** True while this pane (its terminal or its own chrome) holds the keyboard. */
  isFocused: () => boolean
  /** Scrolls to the neighbouring prompt; false when there is none that way. */
  scrollToPrompt: (direction: TerminalPromptDirection) => boolean
}

const mountedTerminalPromptNavigations: MountedTerminalPromptNavigation[] = []

/**
 * The pane that should answer, or null when none is mounted.
 *
 * `activeWorkspaceId` is read at dispatch time rather than captured, so a pane
 * registered before the user switched workspaces does not answer for the one
 * they are looking at now.
 */
export function respondToTerminalPromptNavigation(
  activeWorkspaceId: string | null,
  direction: TerminalPromptDirection,
): MountedTerminalPromptNavigation | null {
  const responder =
    mountedTerminalPromptNavigations.find((entry) => entry.isFocused()) ??
    [...mountedTerminalPromptNavigations]
      .reverse()
      .find((entry) => entry.workspaceId !== null && entry.workspaceId === activeWorkspaceId) ??
    null
  responder?.scrollToPrompt(direction)
  return responder
}

function onTerminalPromptNavigationPanelCommand(event: Event): void {
  const detail = (event as CustomEvent<{ id?: string }>).detail
  const direction: TerminalPromptDirection | null =
    detail?.id === TERMINAL_PROMPT_PREVIOUS_COMMAND
      ? 'previous'
      : detail?.id === TERMINAL_PROMPT_NEXT_COMMAND
        ? 'next'
        : null
  if (!direction) return
  respondToTerminalPromptNavigation(useWorkspaceStore.getState().activeWorkspaceId ?? null, direction)
}

/**
 * Registers a mounted pane as a possible responder; returns the unregister.
 *
 * ONE window listener for the whole app, installed when the first pane
 * registers and removed when the last unregisters — a listener per pane would
 * run the election once per mounted terminal.
 */
export function registerMountedTerminalPromptNavigation(entry: MountedTerminalPromptNavigation): () => void {
  if (mountedTerminalPromptNavigations.length === 0) {
    window.addEventListener(PANEL_COMMAND_EVENT, onTerminalPromptNavigationPanelCommand)
  }
  mountedTerminalPromptNavigations.push(entry)
  return () => {
    const index = mountedTerminalPromptNavigations.indexOf(entry)
    if (index >= 0) mountedTerminalPromptNavigations.splice(index, 1)
    if (mountedTerminalPromptNavigations.length === 0) {
      window.removeEventListener(PANEL_COMMAND_EVENT, onTerminalPromptNavigationPanelCommand)
    }
  }
}

/** Test seam: the responder list is module state, so a test must be able to empty it. */
export function resetMountedTerminalPromptNavigations(): void {
  mountedTerminalPromptNavigations.length = 0
  window.removeEventListener(PANEL_COMMAND_EVENT, onTerminalPromptNavigationPanelCommand)
}
