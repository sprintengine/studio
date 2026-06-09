import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import type { GuidedBriefRuntimeState } from '../../../types/workspace'
import {
  createGuidedBriefSessionId,
  startGuidedBriefSpecialistSession,
  type GuidedBriefSessionLifecycle,
  type GuidedBriefSpecialistSession,
} from './sessionAdapter'
import { joinWorkspacePath } from './paths'
import {
  EMPTY_DESIGN_ARTIFACT_INDEX,
  INSPIRATION_DIRECTORY_NAME,
  MOCKUPS_DIRECTORY_NAME,
  UI_DIRECTION_RELATIVE_PATH,
  collectDesignArtifacts,
  type DesignArtifactEntry,
  type DesignArtifactIndex,
  type DesignArtifactsStatus,
} from './designArtifacts'

export type DesignerMockupFile = {
  name: string
  absolutePath: string
  relativePath: string
}

/**
 * Designer working → ready transition, as a pure functional patch. It only
 * advances the stage and leaves every other field untouched, so it can be passed
 * to `onChange` as a functional updater and merge onto the latest committed
 * runtime state. That is what prevents the designer-readiness race: when mockups
 * appear, the stage-flip, active-mockup, and session-id effects all fire in the
 * same React commit; spreading a stale whole-runtime snapshot made the later
 * value-update clobber the stage flip and strand the workspace in
 * `designer-working`. Returning a narrow patch (or `prev` unchanged) keeps the
 * concurrent updates intact.
 */
export function nextDesignerStageForReadiness(
  prev: GuidedBriefRuntimeState,
  isReady: boolean,
): GuidedBriefRuntimeState {
  if (prev.stage === 'designer-working' && isReady) {
    return { ...prev, stage: 'designer-ready' }
  }
  return prev
}

export type DesignerSessionReadiness = {
  markerReceived: boolean
  mockupsAvailable: boolean
  uiDirectionReady: boolean
  isReady: boolean
}

export type DesignerSessionStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'ready'
  | 'exited'
  | 'error'

export type UseDesignerSessionInput = {
  workspaceRoot: string
  acceptedBriefSnapshotPath?: string
  acceptedArchitecturePlanPath?: string | null
  cli: AgentCli
  cliModel?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  enabled: boolean
  // Persisted PTY id (survives renderer HMR / reload). When provided, the main
  // process reattaches to the existing session and replays its buffer.
  sessionId: string | null
  onAssignSessionId: (sessionId: string) => void
}

export type UseDesignerSessionResult = {
  status: DesignerSessionStatus
  error: string | null
  readiness: DesignerSessionReadiness
  session: GuidedBriefSpecialistSession | null
  uiDirectionPath: string
  mockupsDirectoryPath: string
  mockups: DesignerMockupFile[]
  /** Full design-artifact index (pages, stylesheets, scripts, assets, notes, inspiration). */
  designArtifacts: DesignArtifactIndex
  designArtifactsStatus: DesignArtifactsStatus
}

const PRIMARY_MOCKUP_RELATIVE_PATH = 'mockups/app.html'
const POLL_INTERVAL_MS = 2500

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

function toDesignerMockupFile(entry: DesignArtifactEntry): DesignerMockupFile {
  return {
    name: entry.name,
    absolutePath: entry.absolutePath,
    relativePath: entry.relativePath,
  }
}

export function useDesignerSession({
  workspaceRoot,
  acceptedBriefSnapshotPath,
  acceptedArchitecturePlanPath,
  cli,
  cliModel,
  cliRuntimes,
  enabled,
  sessionId,
  onAssignSessionId,
}: UseDesignerSessionInput): UseDesignerSessionResult {
  const [status, setStatus] = useState<DesignerSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [markerReceived, setMarkerReceived] = useState(false)
  const [mockups, setMockups] = useState<DesignerMockupFile[]>([])
  const [designArtifacts, setDesignArtifacts] = useState<DesignArtifactIndex>(
    EMPTY_DESIGN_ARTIFACT_INDEX,
  )
  const [designArtifactsStatus, setDesignArtifactsStatus] =
    useState<DesignArtifactsStatus>('loading')
  const [uiDirectionReady, setUiDirectionReady] = useState(false)
  const [session, setSession] = useState<GuidedBriefSpecialistSession | null>(null)

  const uiDirectionAbsolutePath = joinWorkspacePath(workspaceRoot, UI_DIRECTION_RELATIVE_PATH)
  const mockupsDirectoryPath = joinWorkspacePath(workspaceRoot, MOCKUPS_DIRECTORY_NAME)

  const startedRef = useRef(false)
  const assignSessionIdRef = useRef(onAssignSessionId)
  assignSessionIdRef.current = onAssignSessionId

  // Start (or reattach to) the designer session once the consumer marks it
  // enabled. The accepted brief snapshot path is required and must already
  // exist. A persisted sessionId reattaches to the existing PTY (main replays
  // its buffer) so HMR / renderer reloads do not restart the agent.
  useEffect(() => {
    if (!enabled) return
    if (startedRef.current) return
    startedRef.current = true

    let cancelled = false
    let activeSession: GuidedBriefSpecialistSession | null = null

    // Mint and persist synchronously before terminalSpawn — see the matching
    // comment in useStrategistSession for the mid-spawn refresh rationale.
    const resolvedSessionId = sessionId ?? createGuidedBriefSessionId()
    if (!sessionId) {
      assignSessionIdRef.current(resolvedSessionId)
    }

    setStatus('starting')
    void startGuidedBriefSpecialistSession(
      {
        kind: 'designer',
        workspaceRoot,
        acceptedBriefSnapshotPath,
        acceptedArchitecturePlanPath,
        sessionId: resolvedSessionId,
        cli,
        cliModel,
        inspirationDirectoryPath: INSPIRATION_DIRECTORY_NAME,
        uiDirectionPath: UI_DIRECTION_RELATIVE_PATH,
        mockupPath: PRIMARY_MOCKUP_RELATIVE_PATH,
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
      if (cancelled) {
        // PTY survives across remounts — explicit teardown happens on stage
        // transitions and on user-confirmed close, not on cleanup.
        return
      }
      if (!result.ok) {
        setError(result.message)
        setStatus('error')
        return
      }
      activeSession = result.session
      setSession(result.session)
      // Defensive: same id we passed in. Call again to self-heal any closure
      // skew between mount and resolve.
      assignSessionIdRef.current(result.session.sessionId)
    })

    return () => {
      cancelled = true
      const current = activeSession
      if (current) current.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // Build the real design-artifact index from disk and keep it fresh. The HTML
  // pages drive the existing designer readiness (mockupsAvailable); the broader
  // index (stylesheets, scripts, assets, notes, inspiration) is for studio
  // browsing and selection. Watch all three source roots — the mockups tree,
  // product/ (for ui-direction.md), and the inspiration tree — plus a poll
  // fallback because macOS fs.watch can miss create events on a directory that
  // was empty when the watcher started.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const stopWatchers: Array<() => Promise<void>> = []

    const refresh = async () => {
      try {
        const rootExists = await window.api.pathExists(workspaceRoot)
        if (cancelled) return
        if (!rootExists) {
          setDesignArtifacts(EMPTY_DESIGN_ARTIFACT_INDEX)
          setMockups([])
          setDesignArtifactsStatus('unavailable')
          return
        }
        const index = await collectDesignArtifacts(workspaceRoot, {
          readdir: window.api.readdir,
          pathExists: window.api.pathExists,
          statPath: window.api.statPath,
        })
        if (cancelled) return
        setDesignArtifacts(index)
        const pages = index.groups.find((group) => group.id === 'pages')?.entries ?? []
        setMockups(pages.map(toDesignerMockupFile))
        setDesignArtifactsStatus('ready')
      } catch {
        if (!cancelled) {
          setDesignArtifacts(EMPTY_DESIGN_ARTIFACT_INDEX)
          setMockups([])
          setDesignArtifactsStatus('unavailable')
        }
      }
    }

    const watchDirectories = [
      mockupsDirectoryPath,
      joinWorkspacePath(workspaceRoot, 'product'),
      joinWorkspacePath(workspaceRoot, INSPIRATION_DIRECTORY_NAME),
    ]

    void refresh()
    for (const directory of watchDirectories) {
      void window.api
        .watchPath(directory, () => {
          void refresh()
        })
        .then((stop) => {
          if (cancelled) {
            void stop()
            return
          }
          stopWatchers.push(stop)
        })
        .catch(() => {
          // A source directory may not exist yet; the poll keeps checking.
        })
    }

    const pollHandle = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(pollHandle)
      for (const stop of stopWatchers) void stop()
    }
  }, [enabled, workspaceRoot, mockupsDirectoryPath])

  // Watch product/ui-direction.md for non-empty content.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const refresh = async () => {
      try {
        const exists = await window.api.pathExists(uiDirectionAbsolutePath)
        if (cancelled) return
        if (!exists) {
          setUiDirectionReady(false)
          return
        }
        const content = await window.api.readfile(uiDirectionAbsolutePath)
        if (cancelled) return
        setUiDirectionReady(hasContent(content))
      } catch {
        if (!cancelled) setUiDirectionReady(false)
      }
    }

    const productDirectoryPath = joinWorkspacePath(workspaceRoot, 'product')
    void refresh()
    void window.api
      .watchPath(productDirectoryPath, () => {
        void refresh()
      })
      .then((stop) => {
        if (cancelled) {
          void stop()
          return
        }
        stopWatch = stop
      })
      .catch(() => {})

    // Poll for the same reason as the mockups watcher above: fs.watch can miss
    // create events on macOS for files added after the watcher started.
    const pollHandle = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(pollHandle)
      if (stopWatch) void stopWatch()
    }
  }, [enabled, uiDirectionAbsolutePath, workspaceRoot])

  const mockupsAvailable = mockups.length > 0
  // Spec: marker OR real mockup file readiness. We treat "real readiness" as
  // the presence of at least one .html mockup file on disk; the marker is the
  // agent's own ready signal. Either flips the UI to ready state. Accept
  // remains gated on real files only — see GuidedBriefFlow.acceptDesigner.
  const isReady = markerReceived || mockupsAvailable

  return {
    status,
    error,
    readiness: { markerReceived, mockupsAvailable, uiDirectionReady, isReady },
    session,
    uiDirectionPath: uiDirectionAbsolutePath,
    mockupsDirectoryPath,
    mockups,
    designArtifacts,
    designArtifactsStatus,
  }
}
