import React, { useContext } from 'react'

// The host's top-strip slot, for a door surface to portal its bar into. Lives in
// its own module — NOT in GlobalSurfaceShell.tsx — for the same reason
// ContextRailSlotContext does: the host (WorkspaceManager) provides it and the
// shell consumes it, and a context that both sides reach through the same leaf
// module can never end up as two React contexts that silently fail to match.
// While it was declared inside the shell, doors read a different context object
// than the host provided, every door fell back to its inline bar, and the app
// showed two stacked top bars.
//
// `el` is null only for the brief settle before the host's ref attaches.
export type GlobalSurfaceBarSlot = {
  readonly el: HTMLElement | null
}

export const GlobalSurfaceBarSlotContext = React.createContext<GlobalSurfaceBarSlot | null>(null)

/** The host's bar slot, or null when no host offers one (tests, storybook). */
export function useGlobalSurfaceBarSlot(): GlobalSurfaceBarSlot | null {
  return useContext(GlobalSurfaceBarSlotContext)
}
