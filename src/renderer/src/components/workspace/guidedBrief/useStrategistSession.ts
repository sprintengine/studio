import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import {
  startGuidedBriefSpecialistSession,
  type GuidedBriefSessionLifecycle,
  type GuidedBriefSpecialistSession,
} from './sessionAdapter'
import { joinWorkspacePath } from './paths'

export type StrategistSessionReadiness = {
  markerReceived: boolean
  fileReady: boolean
  isReady: boolean
}

export type StrategistSessionStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'ready'
  | 'exited'
  | 'error'

export type UseStrategistSessionInput = {
  workspaceRoot: string
  cli: AgentCli
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  enabled?: boolean
}

export type UseStrategistSessionResult = {
  status: StrategistSessionStatus
  error: string | null
  readiness: StrategistSessionReadiness
  session: GuidedBriefSpecialistSession | null
  requirementsPath: string
}

const REQUIREMENTS_RELATIVE_PATH = 'product/requirements.md'
const IDEA_SEED_RELATIVE_PATH = 'product/idea-seed.md'

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

export function useStrategistSession({
  workspaceRoot,
  cli,
  cliRuntimes,
  enabled = true,
}: UseStrategistSessionInput): UseStrategistSessionResult {
  const [status, setStatus] = useState<StrategistSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [markerReceived, setMarkerReceived] = useState(false)
  const [fileReady, setFileReady] = useState(false)
  const [session, setSession] = useState<GuidedBriefSpecialistSession | null>(null)

  const requirementsAbsolutePath = joinWorkspacePath(workspaceRoot, REQUIREMENTS_RELATIVE_PATH)
  const productDirectoryPath = joinWorkspacePath(workspaceRoot, 'product')

  const startedRef = useRef(false)

  // Start the strategist session exactly once per mount.
  useEffect(() => {
    if (!enabled) return
    if (startedRef.current) return
    startedRef.current = true

    let cancelled = false
    let activeSession: GuidedBriefSpecialistSession | null = null

    setStatus('starting')
    void startGuidedBriefSpecialistSession(
      {
        kind: 'strategist',
        workspaceRoot,
        cli,
        ideaSeedPath: IDEA_SEED_RELATIVE_PATH,
        requirementsPath: REQUIREMENTS_RELATIVE_PATH,
      },
      {
        terminalApi: {
          terminalSpawn: window.api.terminalSpawn,
          terminalWrite: window.api.terminalWrite,
          terminalWriteFast: window.api.terminalWriteFast,
          terminalKill: window.api.terminalKill,
          onTerminalData: window.api.onTerminalData,
          onTerminalExit: window.api.onTerminalExit,
          onTerminalError: window.api.onTerminalError,
        },
        cliRuntimes,
        onLifecycle: (next: GuidedBriefSessionLifecycle) => {
          if (cancelled) return
          if (next === 'ready') setMarkerReceived(true)
          if (next === 'error') return
          setStatus(next === 'starting' ? 'starting' : next)
        },
        onMarker: () => {
          if (cancelled) return
          setMarkerReceived(true)
        },
        onError: (message) => {
          if (cancelled) return
          setError(message)
          setStatus('error')
        },
      },
    ).then((result) => {
      if (cancelled) {
        if (result.ok) void result.session.stop().catch(() => {})
        return
      }
      if (!result.ok) {
        setError(result.message)
        setStatus('error')
        return
      }
      activeSession = result.session
      setSession(result.session)
    })

    return () => {
      cancelled = true
      const current = activeSession
      if (current) {
        current.dispose()
        void current.stop().catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // Watch the product directory for requirements.md becoming non-empty.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const checkRequirements = async () => {
      try {
        const exists = await window.api.pathExists(requirementsAbsolutePath)
        if (cancelled) return
        if (!exists) {
          if (fileReady) setFileReady(false)
          return
        }
        const content = await window.api.readfile(requirementsAbsolutePath)
        if (cancelled) return
        setFileReady(hasContent(content))
      } catch {
        if (!cancelled) setFileReady(false)
      }
    }

    void checkRequirements()

    void window.api
      .watchPath(productDirectoryPath, () => {
        void checkRequirements()
      })
      .then((stop) => {
        if (cancelled) {
          void stop()
          return
        }
        stopWatch = stop
      })
      .catch(() => {
        // Fallback: leave only the initial check if the watch cannot start.
      })

    return () => {
      cancelled = true
      if (stopWatch) void stopWatch()
    }
  }, [enabled, productDirectoryPath, requirementsAbsolutePath, fileReady])

  const isReady = markerReceived || fileReady

  return {
    status,
    error,
    readiness: { markerReceived, fileReady, isReady },
    session,
    requirementsPath: requirementsAbsolutePath,
  }
}
