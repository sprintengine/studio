import { useEffect, useRef } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { parseSwarmStateFile } from '../../utils/swarmStateFile'

const SWARM_STATE_WATCH_DEBOUNCE_MS = 120
const SWARM_STATE_RECOVERY_POLL_MS = 2_000
const SWARM_STATE_UNCHANGED_LOG_INTERVAL_MS = 30_000

function getParentDirectoryPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : normalized
}

function getBaseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

export default function SwarmStateSynchronizer({ workspaceId }: { workspaceId: string }) {
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
    let pollInterval: number | null = null
    const stateFilePath = workspace.swarmContext.statePath
    const swarmDirectory = getParentDirectoryPath(stateFilePath)

    const readExternalState = async (cause: 'initial' | 'watch' | 'poll') => {
      const startedAt = performance.now()
      readCountRef.current += 1
      try {
        const content = await window.api.readfile(stateFilePath)
        const changed = content !== lastSyncedContentRef.current
        if (disposed) return
        if (!changed) {
          const now = Date.now()
          if (now - lastUnchangedLogAtRef.current >= SWARM_STATE_UNCHANGED_LOG_INTERVAL_MS) {
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
          return
        }

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
      } catch (error) {
        logPerfEvent('SwarmState', 'refresh-error', {
          workspaceId,
          team: workspace.swarmState?.name ?? getBaseName(swarmDirectory),
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          message: error instanceof Error ? error.message : String(error),
          readCount: readCountRef.current,
        })
        // The swarm tool may not have created state.yaml yet.
      }
    }

    const startWatching = async () => {
      try {
        stopWatching = await window.api.watchPath(swarmDirectory, (event) => {
          if (event.path && !event.path.endsWith('state.yaml')) return
          if (debounce !== null) window.clearTimeout(debounce)
          debounce = window.setTimeout(() => { void readExternalState('watch') }, SWARM_STATE_WATCH_DEBOUNCE_MS)
        })

        if (disposed && stopWatching) {
          void stopWatching()
          stopWatching = null
        }
      } catch {
        // WSL and network-backed folders may not support fs.watch reliably.
      }
    }

    void readExternalState('initial')
    void startWatching()
    pollInterval = window.setInterval(() => { void readExternalState('poll') }, SWARM_STATE_RECOVERY_POLL_MS)

    return () => {
      disposed = true
      if (debounce !== null) window.clearTimeout(debounce)
      if (pollInterval !== null) window.clearInterval(pollInterval)
      if (stopWatching) void stopWatching()
    }
  }, [folderReadyPath, setSwarmState, workspace?.swarmContext?.statePath, workspaceId])

  return null
}
