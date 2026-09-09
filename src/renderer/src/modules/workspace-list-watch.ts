// The open workspaces, for module renderers (RendererHost.listWorkspaces /
// watchWorkspaces). `getWorkspace(id)` answers "what is this one?"; a module
// whose surface is not mounted inside a workspace panel — a modal floating
// over the window, a settings section — has no id to ask about and needs the
// list itself (which project roots are open, which workspace to act on).
//
// The rows are the same read-only ModuleWorkspaceView the single-workspace
// resolver hands out, built fresh per read so a module never holds a store
// reference. Ports are injected so the contract is unit-testable; modules/index
// wires the real store at boot.

import type { ModuleWorkspaceView } from '../../../shared/modules/workspace-view'

export type WorkspaceListPorts = {
  /** The current workspaces as fresh views, in the store's own order. */
  list: () => ModuleWorkspaceView[]
  /** Store subscription; cb fires on every store change. Returns unsubscribe. */
  subscribe: (cb: () => void) => () => void
}

export type WorkspaceListSource = {
  list(): ModuleWorkspaceView[]
  /** Fires once with the current list, then on every change (deduped by value). */
  watch(cb: (workspaces: ModuleWorkspaceView[]) => void): () => void
}

function signature(workspaces: readonly ModuleWorkspaceView[]): string {
  return JSON.stringify(workspaces)
}

export function createWorkspaceListSource(ports: WorkspaceListPorts): WorkspaceListSource {
  return {
    list: () => ports.list(),
    watch(cb) {
      let last: string | null = null
      const emit = (): void => {
        const workspaces = ports.list()
        // By value, not identity: the store hands out a new array on every
        // unrelated write, and a module list that re-renders on each keystroke
        // in some other surface is the defect this dedupe exists for.
        const next = signature(workspaces)
        if (next === last) return
        last = next
        try {
          cb(workspaces)
        } catch (error) {
          // A throwing module callback must not break the store's emit loop.
          console.error('[modules] workspace list watch callback threw:', error)
        }
      }
      const unsubscribe = ports.subscribe(emit)
      emit()
      return unsubscribe
    },
  }
}
