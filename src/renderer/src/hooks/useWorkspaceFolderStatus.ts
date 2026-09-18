import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'

type FolderCheckState = {
  path: string | null
  status: 'idle' | 'checking' | 'ready' | 'missing' | 'inaccessible' | 'timeout'
  message?: string
  checkedPath?: string
}

export type WorkspaceFolderStatus = {
  folderPath: string | null
  folderReadyPath: string | null
  folderMissing: boolean
  checkingFolder: boolean
  status: FolderCheckState['status']
  message: string | null
  checkedPath: string | null
  recheckFolder: () => Promise<boolean>
}

export function useWorkspaceFolderStatus(workspaceId: string): WorkspaceFolderStatus {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const persistedMissing = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderMissing ?? false,
  )
  const setFolderMissing = useWorkspaceStore((s) => s.setFolderMissing)
  const [checkState, setCheckState] = useState<FolderCheckState>({
    path: null,
    status: 'idle',
  })

  const applyCheckResult = useCallback(
    (path: string, result: WorkspaceFolderCheckResult) => {
      setCheckState({
        path,
        status: result.ok ? 'ready' : result.status,
        message: result.message,
        checkedPath: result.checkedPath,
      })
      setFolderMissing(workspaceId, !result.ok)
    },
    [setFolderMissing, workspaceId],
  )

  const recheckFolder = useCallback(async () => {
    if (!folderPath) {
      setCheckState({ path: null, status: 'idle' })
      setFolderMissing(workspaceId, false)
      return true
    }

    setCheckState({ path: folderPath, status: 'checking' })
    try {
      const result = await window.api.checkWorkspaceFolder(folderPath)
      applyCheckResult(folderPath, result)
      return result.ok
    } catch (error) {
      applyCheckResult(folderPath, {
        ok: false,
        status: 'inaccessible',
        path: folderPath,
        checkedPath: folderPath,
        message: error instanceof Error ? error.message : 'Failed to check workspace folder.',
      })
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
    window.api
      .checkWorkspaceFolder(folderPath)
      .then((result) => {
        if (!cancelled) applyCheckResult(folderPath, result)
      })
      .catch((error) => {
        if (!cancelled) {
          applyCheckResult(folderPath, {
            ok: false,
            status: 'inaccessible',
            path: folderPath,
            checkedPath: folderPath,
            message: error instanceof Error ? error.message : 'Failed to check workspace folder.',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [applyCheckResult, folderPath, setFolderMissing, workspaceId])

  return useMemo(() => {
    const checkedCurrentPath = checkState.path === folderPath
    const status = checkedCurrentPath ? checkState.status : folderPath ? 'checking' : 'idle'
    const folderMissing =
      Boolean(folderPath) &&
      (status === 'missing' || status === 'inaccessible' || status === 'timeout' || persistedMissing)
    const checkingFolder = Boolean(folderPath) && status === 'checking'
    const folderReadyPath = Boolean(folderPath) && status === 'ready' && !folderMissing ? folderPath : null

    return {
      folderPath,
      folderReadyPath,
      folderMissing,
      checkingFolder,
      status,
      message: checkedCurrentPath ? (checkState.message ?? null) : null,
      checkedPath: checkedCurrentPath ? (checkState.checkedPath ?? null) : null,
      recheckFolder,
    }
  }, [checkState, folderPath, persistedMissing, recheckFolder])
}
