import { useEffect, useRef } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { parseSwarmStateFile } from '../../utils/sprintengineStateFile'

const SPRINTENGINE_STATE_WATCH_DEBOUNCE_MS = 120
const SPRINTENGINE_STATE_RECOVERY_INITIAL_MS = 10_000
const SPRINTENGINE_STATE_WATCH_RECOVERY_INITIAL_MS = 60_000
const SPRINTENGINE_STATE_RECOVERY_MAX_MS = 120_000
const SPRINTENGINE_STATE_UNCHANGED_LOG_INTERVAL_MS = 30_000

type SwarmStateRefreshCause = 'initial' | 'watch' | 'recovery'

function getParentDirectoryPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : normalized
}

function getBaseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

export default function SprintEngineStateSynchronizer({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const setSwarmState = useWorkspaceStore((s) => s.setSwarmState)
  const { folderReadyPath } = useWorkspaceFolderStatus(workspaceId)
  const lastSyncedContentRef = useRef<string | null>(null)
  const readCountRef = useRef(0)
  const lastUnchangedLogAtRef = useRef(0)

  useEffect(() => {
    if (!workspace?.swarmContext?.statePath || !folderReadyPath) return

    let disposed = false
    let stopWatching: (() => Promise<void>) | null = null
    let debounce: number | null = null
    let recoveryTimeout: number | null = null
    let recoveryDelayMs = SPRINTENGINE_STATE_RECOVERY_INITIAL_MS
    let watching = false
    const stateFilePath = workspace.swarmContext.statePath
    const swarmDirectory = getParentDirectoryPath(stateFilePath)

    lastSyncedContentRef.current = null
    readCountRef.current = 0
    lastUnchangedLogAtRef.current = 0

    const clearRecoveryTimeout = () => {
      if (recoveryTimeout !== null) {
        window.clearTimeout(recoveryTimeout)
        recoveryTimeout = null
      }
    }

    const resetRecoveryDelay = () => {
      recoveryDelayMs = watching
        ? SPRINTENGINE_STATE_WATCH_RECOVERY_INITIAL_MS
        : SPRINTENGINE_STATE_RECOVERY_INITIAL_MS
    }

    const backOffRecoveryDelay = () => {
      recoveryDelayMs = Math.min(recoveryDelayMs * 2, SPRINTENGINE_STATE_RECOVERY_MAX_MS)
    }

    const scheduleRecovery = () => {
      clearRecoveryTimeout()
      if (disposed || document.hidden) return

      recoveryTimeout = window.setTimeout(() => {
        recoveryTimeout = null
        void readExternalState('recovery')
      }, recoveryDelayMs)
    }

    const readExternalState = async (cause: SwarmStateRefreshCause) => {
      const startedAt = performance.now()
      readCountRef.current += 1
      try {
        const content = await window.api.readfile(stateFilePath)
        const changed = content !== lastSyncedContentRef.current
        if (disposed) return
        if (!changed) {
          if (cause === 'recovery') backOffRecoveryDelay()
          const now = Date.now()
          if (now - lastUnchangedLogAtRef.current >= SPRINTENGINE_STATE_UNCHANGED_LOG_INTERVAL_MS) {
            lastUnchangedLogAtRef.current = now
            logPerfEvent('SwarmState', 'refresh', {
              workspaceId,
              team: workspace.swarmState?.name ?? getBaseName(swarmDirectory),
              cause,
              elapsedMs: Math.round(performance.now() - startedAt),
              changed: false,
              readCount: readCountRef.current,
            })
          }
          scheduleRecovery()
          return
        }

        resetRecoveryDelay()
        const parsed = parseSwarmStateFile(content, getBaseName(swarmDirectory))
        lastSyncedContentRef.current = content
        setSwarmState(workspaceId, parsed)
        logPerfEvent('SwarmState', 'refresh', {
          workspaceId,
          team: parsed.name,
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          changed: true,
          taskCount: parsed.tasks.length,
          artifactCount: parsed.artifacts.length,
          readCount: readCountRef.current,
        })
        scheduleRecovery()
      } catch (error) {
        if (cause === 'recovery') backOffRecoveryDelay()
        logPerfEvent('SwarmState', 'refresh-error', {
          workspaceId,
          team: workspace.swarmState?.name ?? getBaseName(swarmDirectory),
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          message: error instanceof Error ? error.message : String(error),
          readCount: readCountRef.current,
        })
        // The Sprint Engine tool may not have created state.yaml yet.
        scheduleRecovery()
      }
    }

    const startWatching = async () => {
      try {
        stopWatching = await window.api.watchPath(swarmDirectory, (event) => {
          if (event.path && !event.path.endsWith('state.yaml')) return
          if (debounce !== null) window.clearTimeout(debounce)
          debounce = window.setTimeout(() => { void readExternalState('watch') }, SPRINTENGINE_STATE_WATCH_DEBOUNCE_MS)
        })
        watching = true
        resetRecoveryDelay()
        scheduleRecovery()

        if (disposed && stopWatching) {
          void stopWatching()
          stopWatching = null
        }
      } catch {
        // WSL and network-backed folders may not support fs.watch reliably.
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
  }, [folderReadyPath, setSwarmState, workspace?.swarmContext?.statePath, workspaceId])

  return null
}
