import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import { openWorkspaceIds } from '../utils/agentWorktreeCleanup'
import { ensureChatWorktree } from '../utils/chatWorktreeRestore'

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
  // A folder on an SSH machine (phase 8) is that machine's: this computer
  // cannot look at it, and must not mark it missing for not finding it here.
  const folderPath = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    return workspace?.environment ? null : (workspace?.folderPath ?? null)
  })
  const persistedMissing = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderMissing ?? false,
  )
  const setFolderMissing = useWorkspaceStore((s) => s.setFolderMissing)
  // The cleanup's mark on a chat whose worktree it gave back. Arriving while
  // the chat is mounted, it is news about the folder, so the folder is looked
  // at again. Brought back only for a chat open in some window: a chat merely
  // kept mounted behind another would otherwise bring its worktree straight
  // back after every sweep, and does so once it is opened.
  const reclaimedAt = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.worktree?.reclaimedAt)
  const openInAWindow = useWorkspaceStore((s) => openWorkspaceIds(s).includes(workspaceId))
  const restoreHere = reclaimedAt === undefined || openInAWindow
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
      await ensureChatWorktree(workspaceId)
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
    // A chat whose worktree the cleanup gave back gets it back before the
    // folder is judged: until then the panels wait on 'checking', which is
    // what keeps a terminal from starting in a folder that is not there yet.
    ;(restoreHere ? ensureChatWorktree(workspaceId) : Promise.resolve(false))
      .then(() => window.api.checkWorkspaceFolder(folderPath))
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
  }, [applyCheckResult, folderPath, reclaimedAt, restoreHere, setFolderMissing, workspaceId])

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
