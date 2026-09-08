import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import {
  createGuidedBriefSessionId,
  guidedBriefSpecialistAgentId,
  startGuidedBriefSpecialistSession,
  type GuidedBriefSessionLifecycle,
  type GuidedBriefSpecialistSession,
} from './sessionAdapter'
import { startGuidedBriefConversationSession } from './conversationSessionAdapter'
import {
  EMPTY_GUIDED_INTERVIEW_STATE,
  type GuidedInterviewState,
} from './interviewProtocol'
import { joinWorkspacePath } from './paths'
import { useStageLiveStatus } from './useStageLiveStatus'
import { isAgentQuiet, isStageReady, type StageLiveStatus } from './stageReadiness'

type ArchitectSessionReadiness = {
  markerReceived: boolean
  fileReady: boolean
  isReady: boolean
}

type ArchitectSessionStatus =
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
  // 'conversation' runs the specialist as a Claude conversation session
  // (structured question cards, no PTY); requires workspaceId.
  transport?: 'terminal' | 'conversation'
  workspaceId?: string
}

export type UseArchitectSessionResult = {
  status: ArchitectSessionStatus
  error: string | null
  readiness: ArchitectSessionReadiness
  /** Live specialist status from the transport's own session signal (MC-1503). */
  liveStatus: StageLiveStatus
  session: GuidedBriefSpecialistSession | null
  architecturePlanPath: string
  /** Optional agent-produced HTML overview of the plan (`architecture/overview.html`). */
  overviewPath: string
  overviewFileReady: boolean
  /** Structured interview parsed from the session stream (replay included). */
  interview: GuidedInterviewState
  /** Conversation transport only: recent streamed assistant text for the chat pane. */
  transcriptTail: string
}

const ARCHITECTURE_PLAN_RELATIVE_PATH = 'architecture/plan.md'
const ARCHITECTURE_OVERVIEW_RELATIVE_PATH = 'architecture/overview.html'
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
  transport = 'terminal',
  workspaceId,
}: UseArchitectSessionInput): UseArchitectSessionResult {
  const [status, setStatus] = useState<ArchitectSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [markerReceived, setMarkerReceived] = useState(false)
  const [fileReady, setFileReady] = useState(false)
  const [session, setSession] = useState<GuidedBriefSpecialistSession | null>(null)
  const [interview, setInterview] = useState<GuidedInterviewState>(EMPTY_GUIDED_INTERVIEW_STATE)
  const [transcriptTail, setTranscriptTail] = useState('')
  const [overviewFileReady, setOverviewFileReady] = useState(false)

  const overviewAbsolutePath = joinWorkspacePath(workspaceRoot, ARCHITECTURE_OVERVIEW_RELATIVE_PATH)
  const architecturePlanAbsolutePath = joinWorkspacePath(workspaceRoot, ARCHITECTURE_PLAN_RELATIVE_PATH)
  const architectureDirectoryPath = joinWorkspacePath(workspaceRoot, 'architecture')

  // Liveness from the transport's live session status (not "is output
  // streaming"): quiet gates readiness so a mid-write agent never flips the stage.
  const liveStatus = useStageLiveStatus({
    workspaceId,
    agentId: guidedBriefSpecialistAgentId({ kind: 'architect' }),
    transport,
    enabled,
  })
  const agentQuiet = isAgentQuiet(liveStatus)

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
    const sessionInput = {
      kind: 'architect' as const,
      workspaceRoot,
      // Also threaded into the PTY spawn metadata so the session manager
      // inventories the fallback-transport session.
      ...(workspaceId ? { workspaceId } : {}),
      acceptedBriefSnapshotPath,
      sessionId: resolvedSessionId,
      cli,
      cliModel,
      ideaSeedPath: IDEA_SEED_RELATIVE_PATH,
      architecturePlanPath: ARCHITECTURE_PLAN_RELATIVE_PATH,
    }
    const sessionCallbacks = {
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
      onInterview: (state: GuidedInterviewState) => {
        if (cancelled) return
        setInterview(state)
      },
      onOutput: (chunk: { chunk: string }) => {
        if (cancelled || transport !== 'conversation') return
        setTranscriptTail((current) => `${current}${chunk.chunk}`.slice(-8000))
      },
      onError: (message: string) => {
        if (cancelled) return
        setError(message)
        setStatus('error')
      },
    }
    const startPromise =
      transport === 'conversation' && workspaceId
        ? startGuidedBriefConversationSession(
            { ...sessionInput, workspaceId },
            { ...sessionCallbacks, conversationApi: window.api }
          )
        : startGuidedBriefSpecialistSession(sessionInput, {
            ...sessionCallbacks,
            terminalApi: {
              terminalSpawn: window.api.terminalSpawn,
              terminalKill: window.api.terminalKill,
              onTerminalReplay: window.api.onTerminalReplay,
              onTerminalData: window.api.onTerminalData,
              onTerminalExit: window.api.onTerminalExit,
              onTerminalError: window.api.onTerminalError,
            },
          })
    void startPromise.then((result) => {
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
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const checkNonEmpty = async (
      absolutePath: string,
      setReady: (ready: boolean) => void,
    ) => {
      try {
        const exists = await window.api.pathExists(absolutePath)
        if (cancelled) return
        if (!exists) {
          setReady(false)
          return
        }
        const content = await window.api.readfile(absolutePath)
        if (cancelled) return
        setReady(hasContent(content))
      } catch {
        if (!cancelled) setReady(false)
      }
    }

    const checkPlan = async () => {
      await checkNonEmpty(architecturePlanAbsolutePath, setFileReady)
      await checkNonEmpty(overviewAbsolutePath, setOverviewFileReady)
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
    // `markerReceived` re-runs the file check the moment the marker lands
    // (marker demoted to an extra validation trigger), never a readiness signal
    // on its own.
  }, [enabled, architectureDirectoryPath, architecturePlanAbsolutePath, overviewAbsolutePath, markerReceived])

  // Readiness = validated artifact (non-empty plan) AND a quiet agent. The
  // marker is only a re-validation trigger above.
  const isReady = isStageReady({ artifactsValid: fileReady, agentQuiet })

  return {
    status,
    error,
    readiness: { markerReceived, fileReady, isReady },
    liveStatus,
    session,
    architecturePlanPath: architecturePlanAbsolutePath,
    overviewPath: overviewAbsolutePath,
    overviewFileReady,
    interview,
    transcriptTail,
  }
}
