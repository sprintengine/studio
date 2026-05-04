import { useEffect, useRef } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { MultiloopStateDisplayError } from '../../types/workspace'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { parseMultiloopStateFile } from '../../utils/multiloopStateFile'

const MULTILOOP_STATE_WATCH_DEBOUNCE_MS = 120
const MULTILOOP_STATE_RECOVERY_INITIAL_MS = 10_000
const MULTILOOP_STATE_WATCH_RECOVERY_INITIAL_MS = 60_000
const MULTILOOP_STATE_RECOVERY_MAX_MS = 120_000
const MULTILOOP_STATE_UNCHANGED_LOG_INTERVAL_MS = 30_000

export const MULTILOOP_STATE_SYNC_EVENT = 'multicode:multiloop-state-sync'

export type MultiloopStateSyncEventDetail =
  | { workspaceId: string; status: 'ok'; statePath: string }
  | { workspaceId: string; status: 'error'; statePath: string; error: MultiloopStateDisplayError }

type MultiloopStateRefreshCause = 'initial' | 'watch' | 'recovery'
const syncSnapshots = new Map<string, MultiloopStateSyncEventDetail>()

function getParentDirectoryPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : normalized
}

function getBaseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

function dispatchMultiloopStateSync(detail: MultiloopStateSyncEventDetail): void {
  syncSnapshots.set(detail.workspaceId, detail)
  window.dispatchEvent(new CustomEvent<MultiloopStateSyncEventDetail>(MULTILOOP_STATE_SYNC_EVENT, { detail }))
}

export function getMultiloopStateSyncSnapshot(workspaceId: string): MultiloopStateSyncEventDetail | null {
  return syncSnapshots.get(workspaceId) ?? null
}

function toReadError(error: unknown): MultiloopStateDisplayError {
  return {
    title: 'Missing Multiloop state',
    message: error instanceof Error ? error.message : String(error),
  }
}

export default function MultiloopStateSynchronizer({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const setMultiloopState = useWorkspaceStore((s) => s.setMultiloopState)
  const { folderReadyPath } = useWorkspaceFolderStatus(workspaceId)
  const lastSyncedContentRef = useRef<string | null>(null)
  const readCountRef = useRef(0)
  const lastUnchangedLogAtRef = useRef(0)

  useEffect(() => {
    if (!workspace?.multiloopContext?.statePath || !folderReadyPath) return

    let disposed = false
    let stopWatching: (() => Promise<void>) | null = null
    let debounce: number | null = null
    let recoveryTimeout: number | null = null
    let recoveryDelayMs = MULTILOOP_STATE_RECOVERY_INITIAL_MS
    let watching = false
    const stateFilePath = workspace.multiloopContext.statePath
    const loopDirectory = getParentDirectoryPath(stateFilePath)

    lastSyncedContentRef.current = null
    readCountRef.current = 0
    lastUnchangedLogAtRef.current = 0

    const clearRecoveryTimeout = () => {
      if (recoveryTimeout === null) return
      window.clearTimeout(recoveryTimeout)
      recoveryTimeout = null
    }

    const resetRecoveryDelay = () => {
      recoveryDelayMs = watching
        ? MULTILOOP_STATE_WATCH_RECOVERY_INITIAL_MS
        : MULTILOOP_STATE_RECOVERY_INITIAL_MS
    }

    const backOffRecoveryDelay = () => {
      recoveryDelayMs = Math.min(recoveryDelayMs * 2, MULTILOOP_STATE_RECOVERY_MAX_MS)
    }

    const scheduleRecovery = () => {
      clearRecoveryTimeout()
      if (disposed || document.hidden) return

      recoveryTimeout = window.setTimeout(() => {
        recoveryTimeout = null
        void readExternalState('recovery')
      }, recoveryDelayMs)
    }

    const readExternalState = async (cause: MultiloopStateRefreshCause) => {
      const startedAt = performance.now()
      readCountRef.current += 1
      try {
        const content = await window.api.readfile(stateFilePath)
        const changed = content !== lastSyncedContentRef.current
        if (disposed) return
        if (!changed) {
          if (cause === 'recovery') backOffRecoveryDelay()
          const now = Date.now()
          if (now - lastUnchangedLogAtRef.current >= MULTILOOP_STATE_UNCHANGED_LOG_INTERVAL_MS) {
            lastUnchangedLogAtRef.current = now
            logPerfEvent('MultiloopState', 'refresh', {
              workspaceId,
              loop: workspace.multiloopState?.loop.displayName ?? getBaseName(loopDirectory),
              cause,
              elapsedMs: Math.round(performance.now() - startedAt),
              changed: false,
              readCount: readCountRef.current,
            })
          }
          scheduleRecovery()
          return
        }

        const parsed = parseMultiloopStateFile(content)
        lastSyncedContentRef.current = content
        if (!parsed.ok) {
          if (cause === 'recovery') backOffRecoveryDelay()
          dispatchMultiloopStateSync({
            workspaceId,
            status: 'error',
            statePath: stateFilePath,
            error: parsed.error,
          })
          logPerfEvent('MultiloopState', 'refresh-error', {
            workspaceId,
            loop: workspace.multiloopState?.loop.displayName ?? getBaseName(loopDirectory),
            cause,
            elapsedMs: Math.round(performance.now() - startedAt),
            message: parsed.error.message,
            readCount: readCountRef.current,
          })
          scheduleRecovery()
          return
        }

        resetRecoveryDelay()
        setMultiloopState(workspaceId, parsed.state)
        dispatchMultiloopStateSync({ workspaceId, status: 'ok', statePath: stateFilePath })
        logPerfEvent('MultiloopState', 'refresh', {
          workspaceId,
          loop: parsed.state.loop.displayName,
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          changed: true,
          milestoneCount: parsed.state.roadmap.length,
          taskCount: parsed.state.tasks.length,
          artifactCount: parsed.state.artifacts.length,
          readCount: readCountRef.current,
        })
        scheduleRecovery()
      } catch (error) {
        if (disposed) return
        if (cause === 'recovery') backOffRecoveryDelay()
        const readError = toReadError(error)
        dispatchMultiloopStateSync({
          workspaceId,
          status: 'error',
          statePath: stateFilePath,
          error: readError,
        })
        logPerfEvent('MultiloopState', 'refresh-error', {
          workspaceId,
          loop: workspace.multiloopState?.loop.displayName ?? getBaseName(loopDirectory),
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          message: readError.message,
          readCount: readCountRef.current,
        })
        scheduleRecovery()
      }
    }

    const startWatching = async () => {
      try {
        stopWatching = await window.api.watchPath(loopDirectory, (event) => {
          if (event.path && !event.path.endsWith('state.json')) return
          if (debounce !== null) window.clearTimeout(debounce)
          debounce = window.setTimeout(() => { void readExternalState('watch') }, MULTILOOP_STATE_WATCH_DEBOUNCE_MS)
        })
        watching = true
        resetRecoveryDelay()
        scheduleRecovery()

        if (disposed && stopWatching) {
          void stopWatching()
          stopWatching = null
        }
      } catch {
        // Some workspace folders do not support fs.watch reliably; recovery polling still refreshes state.
      }
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearRecoveryTimeout()
        return
      }

      resetRecoveryDelay()
      void readExternalState('recovery')
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    void readExternalState('initial')
    void startWatching()

    return () => {
      disposed = true
      if (debounce !== null) window.clearTimeout(debounce)
      clearRecoveryTimeout()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (stopWatching) void stopWatching()
    }
  }, [folderReadyPath, setMultiloopState, workspace?.multiloopContext?.statePath, workspaceId])

  return null
}
