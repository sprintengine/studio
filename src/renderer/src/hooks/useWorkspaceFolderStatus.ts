import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'

type FolderCheckState = {
  path: string | null
  status: 'idle' | 'checking' | 'ready' | 'missing'
}

export type WorkspaceFolderStatus = {
  folderPath: string | null
  folderReadyPath: string | null
  folderMissing: boolean
  checkingFolder: boolean
  recheckFolder: () => Promise<boolean>
}

export function useWorkspaceFolderStatus(workspaceId: string): WorkspaceFolderStatus {
  const folderPath = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null
  )
  const persistedMissing = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderMissing ?? false
  )
  const setFolderMissing = useWorkspaceStore((s) => s.setFolderMissing)
  const [checkState, setCheckState] = useState<FolderCheckState>({
    path: null,
    status: 'idle',
  })

  const applyCheckResult = useCallback(
    (path: string, exists: boolean) => {
      setCheckState({ path, status: exists ? 'ready' : 'missing' })
      setFolderMissing(workspaceId, !exists)
    },
    [setFolderMissing, workspaceId]
  )

  const recheckFolder = useCallback(async () => {
    if (!folderPath) {
      setCheckState({ path: null, status: 'idle' })
      setFolderMissing(workspaceId, false)
      return true
    }

    setCheckState({ path: folderPath, status: 'checking' })
    try {
      const exists = await window.api.pathExists(folderPath)
      applyCheckResult(folderPath, exists)
      return exists
    } catch {
      applyCheckResult(folderPath, false)
      return false
    }
  }, [applyCheckResult, folderPath, setFolderMissing, workspaceId])

  useEffect(() => {
    let cancelled = false

    if (!folderPath) {
      setCheckState({ path: null, status: 'idle' })
      setFolderMissing(workspaceId, false)
      return
    }

    setCheckState({ path: folderPath, status: 'checking' })
    window.api.pathExists(folderPath)
      .then((exists) => {
        if (!cancelled) applyCheckResult(folderPath, exists)
      })
      .catch(() => {
        if (!cancelled) applyCheckResult(folderPath, false)
      })

    return () => {
      cancelled = true
    }
  }, [applyCheckResult, folderPath, setFolderMissing, workspaceId])

  return useMemo(() => {
    const checkedCurrentPath = checkState.path === folderPath
    const status = checkedCurrentPath ? checkState.status : folderPath ? 'checking' : 'idle'
    const folderMissing = Boolean(folderPath) && (status === 'missing' || persistedMissing)
    const checkingFolder = Boolean(folderPath) && status === 'checking'
    const folderReadyPath = Boolean(folderPath) && status === 'ready' && !folderMissing
      ? folderPath
      : null

    return {
      folderPath,
      folderReadyPath,
      folderMissing,
      checkingFolder,
      recheckFolder,
    }
  }, [checkState, folderPath, persistedMissing, recheckFolder])
}
