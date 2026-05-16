import { useEffect, useRef } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { basename as getBaseName, parentPath as getParentDirectoryPath } from '../../utils/paths'
import { normalizeSprintEngineProjection } from '../../utils/sprintengine'
import { parseSprintEngineStateFile } from '../../utils/sprintengineStateFile'
import type { SprintEngineState } from '../../types/workspace'

const SPRINTENGINE_STATE_WATCH_DEBOUNCE_MS = 120
const SPRINTENGINE_STATE_RECOVERY_INITIAL_MS = 10_000
const SPRINTENGINE_STATE_WATCH_RECOVERY_INITIAL_MS = 60_000
const SPRINTENGINE_STATE_RECOVERY_MAX_MS = 120_000
const SPRINTENGINE_STATE_UNCHANGED_LOG_INTERVAL_MS = 30_000

type SprintEngineStateRefreshCause = 'initial' | 'watch' | 'recovery'

export default function SprintEngineStateSynchronizer({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const setSprintEngineState = useWorkspaceStore((s) => s.setSprintEngineState)
  const { folderReadyPath } = useWorkspaceFolderStatus(workspaceId)
  const lastSyncedContentRef = useRef<string | null>(null)
  const readCountRef = useRef(0)
  const lastUnchangedLogAtRef = useRef(0)

  useEffect(() => {
    if (!workspace?.sprintEngineContext?.statePath || !folderReadyPath) return

    let disposed = false
    let stopWatching: (() => Promise<void>) | null = null
    let debounce: number | null = null
    let recoveryTimeout: number | null = null
    let recoveryDelayMs = SPRINTENGINE_STATE_RECOVERY_INITIAL_MS
    let watching = false
    const stateFilePath = workspace.sprintEngineContext.statePath
    const sprintEngineDirectory = getParentDirectoryPath(stateFilePath)

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

    const readExternalState = async (cause: SprintEngineStateRefreshCause) => {
      const startedAt = performance.now()
      readCountRef.current += 1
      try {
        // Prefer the normalized projection (folder-store source of truth).
        // It carries board columns, activity timelines, lock warnings, and
        // run-summary fields the panels now render. Falls back to legacy
        // state.yaml parsing for unmigrated runs without projection.json.
        const projectionResult = await window.api.readSprintEngineProjection(stateFilePath)
        let parsed: SprintEngineState | null = null
        let signature: string | null = null
        let projectionUnavailableMessage: string | null = null

        if (projectionResult.ok) {
          signature = JSON.stringify(projectionResult.data)
          parsed = normalizeSprintEngineProjection(projectionResult.data, getBaseName(sprintEngineDirectory))
        } else {
          projectionUnavailableMessage = projectionResult.message
        }

        if (!parsed) {
          const content = await window.api.readfile(stateFilePath)
          signature = content
          const fallback = parseSprintEngineStateFile(content, getBaseName(sprintEngineDirectory))
          parsed = {
            ...fallback,
            projection: {
              source: 'unavailable',
              updatedAt: fallback.updatedAt ?? null,
              generatedAt: null,
              ...(projectionUnavailableMessage ? { errorMessage: projectionUnavailableMessage } : {}),
            },
          }
        }

        const changed = signature !== lastSyncedContentRef.current
        if (disposed) return
        if (!changed) {
          if (cause === 'recovery') backOffRecoveryDelay()
          const now = Date.now()
          if (now - lastUnchangedLogAtRef.current >= SPRINTENGINE_STATE_UNCHANGED_LOG_INTERVAL_MS) {
            lastUnchangedLogAtRef.current = now
            logPerfEvent('SprintEngineState', 'refresh', {
              workspaceId,
              team: workspace.sprintEngineState?.name ?? getBaseName(sprintEngineDirectory),
              cause,
              elapsedMs: Math.round(performance.now() - startedAt),
              changed: false,
              readCount: readCountRef.current,
              source: parsed.projection?.source ?? 'unavailable',
            })
          }
          scheduleRecovery()
          return
        }

        resetRecoveryDelay()
        lastSyncedContentRef.current = signature
        setSprintEngineState(workspaceId, parsed)
        logPerfEvent('SprintEngineState', 'refresh', {
          workspaceId,
          team: parsed.name,
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          changed: true,
          taskCount: parsed.tasks.length,
          artifactCount: parsed.artifacts.length,
          readCount: readCountRef.current,
          source: parsed.projection?.source ?? 'unavailable',
        })
        scheduleRecovery()
      } catch (error) {
        if (cause === 'recovery') backOffRecoveryDelay()
        logPerfEvent('SprintEngineState', 'refresh-error', {
          workspaceId,
          team: workspace.sprintEngineState?.name ?? getBaseName(sprintEngineDirectory),
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          message: error instanceof Error ? error.message : String(error),
          readCount: readCountRef.current,
        })
        // The Sprint Engine tool may not have written projection.json or state.yaml yet.
        scheduleRecovery()
      }
    }

    const startWatching = async () => {
      try {
        stopWatching = await window.api.watchPath(sprintEngineDirectory, (event) => {
          if (event.path) {
            const isStateFile = event.path.endsWith('state.yaml')
              || event.path.endsWith('projection.json')
            if (!isStateFile) return
          }
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
  }, [folderReadyPath, setSprintEngineState, workspace?.sprintEngineContext?.statePath, workspaceId])

  return null
}
