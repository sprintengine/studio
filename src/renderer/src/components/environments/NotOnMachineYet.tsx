import type { JSX } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { EmptyState } from '../ui/EmptyState'

// What a pane says in a workspace on an SSH machine when it cannot run there
// yet (phase 8): a terminal, for one. Never this computer's files or shell in
// its place.

/** The SSH machine a workspace is on, by its label, or null for this computer's. */
export function useWorkspaceMachine(workspaceId: string): string | null {
  return useWorkspaceStore((state) => {
    const environment = state.workspaces.find((workspace) => workspace.id === workspaceId)?.environment
    return environment?.kind === 'ssh' ? environment.label : null
  })
}

export function NotOnMachineYet({ what, machine }: { what: string; machine: string }): JSX.Element {
  return (
    <EmptyState
      title={`${what} are not available for SSH machines yet`}
      body={`This workspace is on ${machine}. Its chats, files and git run there; ${what.toLowerCase()} do not yet.`}
    />
  )
}
