import React, { useMemo } from 'react'

import NewSprintDialog from '../components/workspace/newSprint/NewSprintDialog'
import { useWorkspaceStore } from '../store/workspaceStore'
import { PRIMARY_WORKSPACE_WINDOW_ID } from '../store/slices/persistenceSlice'
import type { WorkspaceWindowId } from '../types/workspace'
import { readNewSprintRequest } from './sprint-engine-new-sprint'

function folderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function workspaceWindowIdFromLocation(): WorkspaceWindowId {
  try {
    const value = new URL(window.location.href).searchParams.get('windowId')?.trim()
    return value || PRIMARY_WORKSPACE_WINDOW_ID
  } catch {
    return PRIMARY_WORKSPACE_WINDOW_ID
  }
}

export default function NewSprintModalSurface(): JSX.Element {
  const pending = readNewSprintRequest()
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const closeModalSurface = useWorkspaceStore((state) => state.closeModalSurface)
  const projectOptions = useMemo(() => {
    const seen = new Set<string>()
    const options: Array<{ path: string; label: string }> = []
    for (const workspace of workspaces) {
      const path = workspace.folderPath?.trim()
      if (!path) continue
      const key = path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      options.push({ path, label: folderLabel(path) })
    }
    return options
  }, [workspaces])

  return (
    <NewSprintDialog
      embedded
      initialFolderPath={pending.folderPath}
      initialSource={pending.source}
      projectOptions={projectOptions}
      workspaceWindowId={workspaceWindowIdFromLocation()}
      onClose={closeModalSurface}
    />
  )
}
