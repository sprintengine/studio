import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import {
  createGuidedBriefSessionId,
  startGuidedBriefSpecialistSession,
  type GuidedBriefSessionLifecycle,
  type GuidedBriefSpecialistSession,
} from './sessionAdapter'
import { joinWorkspacePath } from './paths'

export type ArchitectSessionReadiness = {
  markerReceived: boolean
  fileReady: boolean
  isReady: boolean
}

export type ArchitectSessionStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'ready'
  | 'exited'
  | 'error'

export type UseArchitectSessionInput = {
  workspaceRoot: string
  acceptedBriefSnapshotPath: string | null
  cli: AgentCli
  cliModel?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  enabled: boolean
  sessionId: string | null
  onAssignSessionId: (sessionId: string) => void
}

export type UseArchitectSessionResult = {
  status: ArchitectSessionStatus
  error: string | null
  readiness: ArchitectSessionReadiness
  session: GuidedBriefSpecialistSession | null
  architecturePlanPath: string
}

const ARCHITECTURE_PLAN_RELATIVE_PATH = 'architecture/plan.md'
const IDEA_SEED_RELATIVE_PATH = 'product/idea-seed.md'
const POLL_INTERVAL_MS = 2500

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

export function useArchitectSession({
  workspaceRoot,
  acceptedBriefSnapshotPath,
  cli,
  cliModel,
  cliRuntimes,
  enabled,
  sessionId,
  onAssignSessionId,
}: UseArchitectSessionInput): UseArchitectSessionResult {
  const [status, setStatus] = useState<ArchitectSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [markerReceived, setMarkerReceived] = useState(false)
  const [fileReady, setFileReady] = useState(false)
  const [session, setSession] = useState<GuidedBriefSpecialistSession | null>(null)

  const architecturePlanAbsolutePath = joinWorkspacePath(workspaceRoot, ARCHITECTURE_PLAN_RELATIVE_PATH)
  const architectureDirectoryPath = joinWorkspacePath(workspaceRoot, 'architecture')

  const startedRef = useRef(false)
  const assignSessionIdRef = useRef(onAssignSessionId)
  assignSessionIdRef.current = onAssignSessionId

  useEffect(() => {
    if (!enabled) return
    if (startedRef.current) return
    startedRef.current = true

    let cancelled = false
    let activeSession: GuidedBriefSpecialistSession | null = null

    const resolvedSessionId = sessionId ?? createGuidedBriefSessionId()
    if (!sessionId) {
      assignSessionIdRef.current(resolvedSessionId)
    }

    setStatus('starting')
    void startGuidedBriefSpecialistSession(
      {
        kind: 'architect',
        workspaceRoot,
        acceptedBriefSnapshotPath,
        sessionId: resolvedSessionId,
        cli,
        cliModel,
        ideaSeedPath: IDEA_SEED_RELATIVE_PATH,
        architecturePlanPath: ARCHITECTURE_PLAN_RELATIVE_PATH,
      },
      {
        terminalApi: {
          terminalSpawn: window.api.terminalSpawn,
          terminalKill: window.api.terminalKill,
          onTerminalReplay: window.api.onTerminalReplay,
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
      if (cancelled) return
      if (!result.ok) {
        setError(result.message)
        setStatus('error')
        return
      }
      activeSession = result.session
      setSession(result.session)
      assignSessionIdRef.current(result.session.sessionId)
    })

    return () => {
      cancelled = true
      const current = activeSession
      if (current) current.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const checkPlan = async () => {
      try {
        const exists = await window.api.pathExists(architecturePlanAbsolutePath)
        if (cancelled) return
        if (!exists) {
          setFileReady(false)
          return
        }
        const content = await window.api.readfile(architecturePlanAbsolutePath)
        if (cancelled) return
        setFileReady(hasContent(content))
      } catch {
        if (!cancelled) setFileReady(false)
      }
    }

    void checkPlan()
    void window.api
      .watchPath(architectureDirectoryPath, () => {
        void checkPlan()
      })
      .then((stop) => {
        if (cancelled) {
          void stop()
          return
        }
        stopWatch = stop
      })
      .catch(() => {})

    const pollHandle = setInterval(() => {
      void checkPlan()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(pollHandle)
      if (stopWatch) void stopWatch()
    }
  }, [enabled, architectureDirectoryPath, architecturePlanAbsolutePath])

  const isReady = markerReceived || fileReady

  return {
    status,
    error,
    readiness: { markerReceived, fileReady, isReady },
    session,
    architecturePlanPath: architecturePlanAbsolutePath,
  }
}
