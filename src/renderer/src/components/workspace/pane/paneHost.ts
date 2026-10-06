import { createContext, useContext } from 'react'

// Where a pane tab's body is mounted: the workspace window's pane, or a window
// the tab was popped out into. A body reads it only for what has no meaning in
// a window of its own — floating over the workspace needs a workspace beside
// it — and is otherwise the same component in both.

export type PaneHost = 'pane' | 'pop-out'

export const PaneHostContext = createContext<PaneHost>('pane')

export function usePaneHost(): PaneHost {
  return useContext(PaneHostContext)
}
