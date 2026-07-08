import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import {
  createGuidedBriefSessionId,
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
  cliModel?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  enabled?: boolean
  // Persisted PTY id (survives renderer HMR / reload). When provided, the main
  // process reattaches to the existing session and replays its buffer.
  sessionId: string | null
  onAssignSessionId: (sessionId: string) => void
  // 'conversation' runs the specialist as a Claude conversation session
  // (structured question cards, no PTY); requires workspaceId. Defaults to
  // the legacy terminal transport.
  transport?: 'terminal' | 'conversation'
  workspaceId?: string
}

export type UseStrategistSessionResult = {
  status: StrategistSessionStatus
  error: string | null
  readiness: StrategistSessionReadiness
  session: GuidedBriefSpecialistSession | null
  requirementsPath: string
  /** Optional agent-produced HTML overview of the brief (`product/overview.html`). */
  overviewPath: string
  overviewFileReady: boolean
  /** Structured interview parsed from the session stream (replay included). */
  interview: GuidedInterviewState
  /** Conversation transport only: recent streamed assistant text for the chat pane. */
  transcriptTail: string
}

const REQUIREMENTS_RELATIVE_PATH = 'product/requirements.md'
const OVERVIEW_RELATIVE_PATH = 'product/overview.html'
const IDEA_SEED_RELATIVE_PATH = 'product/idea-seed.md'

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

export function useStrategistSession({
  workspaceRoot,
  cli,
  cliModel,
  cliRuntimes,
  enabled = true,
  sessionId,
  onAssignSessionId,
  transport = 'terminal',
  workspaceId,
}: UseStrategistSessionInput): UseStrategistSessionResult {
  const [status, setStatus] = useState<StrategistSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [markerReceived, setMarkerReceived] = useState(false)
  const [fileReady, setFileReady] = useState(false)
  const [session, setSession] = useState<GuidedBriefSpecialistSession | null>(null)
  const [interview, setInterview] = useState<GuidedInterviewState>(EMPTY_GUIDED_INTERVIEW_STATE)
  const [transcriptTail, setTranscriptTail] = useState('')
  const [overviewFileReady, setOverviewFileReady] = useState(false)

  const requirementsAbsolutePath = joinWorkspacePath(workspaceRoot, REQUIREMENTS_RELATIVE_PATH)
  const overviewAbsolutePath = joinWorkspacePath(workspaceRoot, OVERVIEW_RELATIVE_PATH)
  const productDirectoryPath = joinWorkspacePath(workspaceRoot, 'product')

  const startedRef = useRef(false)
  const assignSessionIdRef = useRef(onAssignSessionId)
  assignSessionIdRef.current = onAssignSessionId

  // Start (or reattach to) the strategist session exactly once per mount. A
  // persisted sessionId means the main process keeps the PTY alive across
  // renderer reloads — spawning with the same id reattaches and replays the
  // buffer instead of starting a fresh agent.
  useEffect(() => {
    if (!enabled) return
    if (startedRef.current) return
    startedRef.current = true

    let cancelled = false
    let activeSession: GuidedBriefSpecialistSession | null = null

    // Mint and persist the sessionId synchronously before the terminalSpawn IPC
    // is even queued. A renderer reload mid-spawn would otherwise leave the
    // generated id only in the adapter's resolved promise (which never fires
    // after a reload), orphaning the PTY in main.
    const resolvedSessionId = sessionId ?? createGuidedBriefSessionId()
    if (!sessionId) {
      assignSessionIdRef.current(resolvedSessionId)
    }

    setStatus('starting')
    const sessionInput = {
      kind: 'strategist' as const,
      workspaceRoot,
      sessionId: resolvedSessionId,
      cli,
      cliModel,
      ideaSeedPath: IDEA_SEED_RELATIVE_PATH,
      requirementsPath: REQUIREMENTS_RELATIVE_PATH,
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
      if (cancelled) {
        // Do not kill the PTY here — the session id stays in runtime state so
        // the next mount can reattach. Explicit teardown happens on stage
        // transitions and on user-confirmed close.
        return
      }
      if (!result.ok) {
        setError(result.message)
        setStatus('error')
        return
      }
      activeSession = result.session
      setSession(result.session)
      // Defensive: the adapter returns the same id we passed in, but call the
      // setter again so any closure-skew between mount and resolve self-heals.
      assignSessionIdRef.current(result.session.sessionId)
    })

    return () => {
      cancelled = true
      const current = activeSession
      if (current) current.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // Watch the product directory for requirements.md becoming non-empty.
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

    const checkRequirements = async () => {
      await checkNonEmpty(requirementsAbsolutePath, setFileReady)
      await checkNonEmpty(overviewAbsolutePath, setOverviewFileReady)
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
  }, [enabled, productDirectoryPath, requirementsAbsolutePath, overviewAbsolutePath])

  const isReady = markerReceived || fileReady

  return {
    status,
    error,
    readiness: { markerReceived, fileReady, isReady },
    session,
    requirementsPath: requirementsAbsolutePath,
    overviewPath: overviewAbsolutePath,
    overviewFileReady,
    interview,
    transcriptTail,
  }
}
