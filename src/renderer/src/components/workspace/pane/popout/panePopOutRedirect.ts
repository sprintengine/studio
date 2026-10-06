import type { PanePopOutAction } from '../../../../../../shared/ipc/pane-popout'
import type { SettingsSliceActions } from '../../../../store/slices/settingsSlice'
import type { WorkspacePaneSliceActions } from '../../../../store/slices/workspacePaneSlice'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { WorkspaceId } from '../../../../types/workspace'
import { redirectFileSurface } from '../../../../utils/openFileSurface'

// The pop-out window's half of the pane's writes.
//
// The tab bodies a pop-out mounts are the pane's own components, and they
// write to the pane the way they always do: `updatePaneTab` when a page
// navigates, `setPaneTabBoard` when a board is picked, `closePaneTab` from a
// tab's close glyph. In this window those writes would land in a copy of the
// pane nobody else reads — the owner window's store is the record (see
// panePopOutHost.ts) — so for the window's own workspace each one is sent to
// the owner as an action instead, and this window shows what the owner pushes
// back. Nothing is applied here first: the owner may answer differently (a
// board already open in another tab closes this one), and a window that
// guessed would have to be corrected.
//
// Writes to any other workspace pass through untouched; this window shows one.
// The Diff tab's two app-wide settings go to the owner as well: this window
// writes no settings of its own (workspaceStore's PERSISTS_NOTHING).

type RedirectedWrites = Pick<
  WorkspacePaneSliceActions,
  | 'openPaneTab'
  | 'closePaneTab'
  | 'setActivePaneTab'
  | 'updatePaneTab'
  | 'setPaneTabBoard'
  | 'notePaneRecentUrl'
  | 'setPaneOpen'
  | 'setPaneTabFloating'
  | 'togglePaneKind'
  | 'popOutPaneTabs'
  | 'dockPaneTabs'
> &
  Pick<SettingsSliceActions, 'setDiffOpensInWindow' | 'setDiffView'>

export type PanePopOutRedirectOptions = {
  workspaceId: WorkspaceId
  /** Hand an action to the owner window. */
  act: (action: PanePopOutAction) => void
  /** Bring a tab to the front of this window's own strip. */
  select: (tabId: string) => void
}

// The workspace whose pane writes this window hands to its owner, while the
// redirect is installed.
let handedOff: WorkspaceId | null = null

/**
 * Whether an open for this workspace's pane went to the owner window. The
 * redirected `openPaneTab` answers null — the tab's id is the owner's to mint
 * — and an opener that reads null as "the pane could not take it" (a link
 * falling back to the system browser) asks here before it does.
 */
export function paneOpensHandedOff(workspaceId: WorkspaceId): boolean {
  return handedOff === workspaceId
}

/** Install the redirect; the returned function puts the store's own writers back. */
export function redirectPaneWrites({ workspaceId, act, select }: PanePopOutRedirectOptions): () => void {
  const state = useWorkspaceStore.getState()
  const own: RedirectedWrites = {
    openPaneTab: state.openPaneTab,
    closePaneTab: state.closePaneTab,
    setActivePaneTab: state.setActivePaneTab,
    updatePaneTab: state.updatePaneTab,
    setPaneTabBoard: state.setPaneTabBoard,
    notePaneRecentUrl: state.notePaneRecentUrl,
    setPaneOpen: state.setPaneOpen,
    setPaneTabFloating: state.setPaneTabFloating,
    togglePaneKind: state.togglePaneKind,
    popOutPaneTabs: state.popOutPaneTabs,
    dockPaneTabs: state.dockPaneTabs,
    setDiffOpensInWindow: state.setDiffOpensInWindow,
    setDiffView: state.setDiffView,
  }
  const mine = (id: WorkspaceId): boolean => id === workspaceId
  const redirected: RedirectedWrites = {
    // The owner opens it, and decides where it lands (a new tab joins this
    // window). Its id is not known here until the owner's push arrives, so
    // the answer is null; an opener that would read that as a refusal asks
    // `paneOpensHandedOff` first.
    openPaneTab: (id, input) => {
      if (!mine(id)) return own.openPaneTab(id, input)
      act({ type: 'open', input })
      return null
    },
    closePaneTab: (id, tabId) => (mine(id) ? act({ type: 'close', tabId }) : own.closePaneTab(id, tabId)),
    // Which tab is in front is this window's own business; the owner only
    // remembers it, so docking back lands on it.
    setActivePaneTab: (id, tabId) => {
      if (!mine(id)) return own.setActivePaneTab(id, tabId)
      select(tabId)
      act({ type: 'activate', tabId })
    },
    updatePaneTab: (id, tabId, patch) =>
      mine(id) ? act({ type: 'update', tabId, patch }) : own.updatePaneTab(id, tabId, patch),
    setPaneTabBoard: (id, tabId, path) =>
      mine(id) ? act({ type: 'set-board', tabId, path }) : own.setPaneTabBoard(id, tabId, path),
    notePaneRecentUrl: (id, url) => (mine(id) ? act({ type: 'recent-url', url }) : own.notePaneRecentUrl(id, url)),
    // No column here to open, close or toggle, no workspace to float a player
    // over, and no pane to pop out of: for this window's workspace these are
    // the owner's alone.
    setPaneOpen: (id, open) => (mine(id) ? undefined : own.setPaneOpen(id, open)),
    setPaneTabFloating: (id, tabId, floating) => (mine(id) ? undefined : own.setPaneTabFloating(id, tabId, floating)),
    togglePaneKind: (id, kind) => (mine(id) ? false : own.togglePaneKind(id, kind)),
    popOutPaneTabs: (id, tabIds, popOutId) => (mine(id) ? undefined : own.popOutPaneTabs(id, tabIds, popOutId)),
    dockPaneTabs: (id, popOutId, options) => (mine(id) ? undefined : own.dockPaneTabs(id, popOutId, options)),
    // The Diff tab's two app-wide settings. This window persists nothing (its
    // settings are a snapshot of when it opened), so the owner records them;
    // they are applied here too, so the tab shows what was picked.
    setDiffOpensInWindow: (enabled) => {
      own.setDiffOpensInWindow(enabled)
      act({ type: 'diff-opens-in-window', enabled })
    },
    setDiffView: (view) => {
      own.setDiffView(view)
      act({ type: 'diff-view', view })
    },
  }
  useWorkspaceStore.setState(redirected)
  handedOff = workspaceId
  // A file picked in a Files or Git tab here opens where files open: in the
  // owner window, which has the editor this one does not.
  const restoreFiles = redirectFileSurface((input) => {
    if (!mine(input.workspaceId)) return false
    act({
      type: 'open-file',
      path: input.path,
      name: input.name,
      ...(input.lineNumber !== undefined ? { lineNumber: input.lineNumber } : {}),
      ...(input.column !== undefined ? { column: input.column } : {}),
    })
    return true
  })
  return () => {
    if (handedOff === workspaceId) handedOff = null
    restoreFiles()
    useWorkspaceStore.setState(own)
  }
}
