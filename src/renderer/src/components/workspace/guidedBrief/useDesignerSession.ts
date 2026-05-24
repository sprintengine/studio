import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import {
  createGuidedBriefSessionId,
  startGuidedBriefSpecialistSession,
  type GuidedBriefSessionLifecycle,
  type GuidedBriefSpecialistSession,
} from './sessionAdapter'
import { joinWorkspacePath } from './paths'

export type DesignerMockupFile = {
  name: string
  absolutePath: string
  relativePath: string
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
}

const UI_DIRECTION_RELATIVE_PATH = 'product/ui-direction.md'
const MOCKUPS_DIRECTORY_NAME = 'mockups'
const INSPIRATION_DIRECTORY_NAME = '.guided-brief/inspiration'
const PRIMARY_MOCKUP_RELATIVE_PATH = 'mockups/app.html'
const POLL_INTERVAL_MS = 2500

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

// Walk mockups/ for .html files. Agents occasionally write to subfolders
// (e.g. mockups/dashboard/index.html) and a top-level scan would miss those —
// leaving designer-ready stuck because mockupsAvailable never flips. The
// recursion is shallow-bounded so a runaway tree can't lock the renderer.
async function collectMockupHtmlFiles(
  absoluteRoot: string,
  relativeRoot: string,
  depth: number,
): Promise<DesignerMockupFile[]> {
  if (depth > 4) return []
  const entries = await window.api.readdir(absoluteRoot).catch(() => [])
  const results: DesignerMockupFile[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDir) {
      const nested = await collectMockupHtmlFiles(
        joinWorkspacePath(absoluteRoot, entry.name),
        `${relativeRoot}/${entry.name}`,
        depth + 1,
      )
      results.push(...nested)
      continue
    }
    if (!/\.html?$/i.test(entry.name)) continue
    results.push({
      name: entry.name,
      absolutePath: joinWorkspacePath(absoluteRoot, entry.name),
      relativePath: `${relativeRoot}/${entry.name}`,
    })
  }
  return results
}

export function useDesignerSession({
  workspaceRoot,
  acceptedBriefSnapshotPath,
  acceptedArchitecturePlanPath,
  cli,
  cliRuntimes,
  enabled,
  sessionId,
  onAssignSessionId,
}: UseDesignerSessionInput): UseDesignerSessionResult {
  const [status, setStatus] = useState<DesignerSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [markerReceived, setMarkerReceived] = useState(false)
  const [mockups, setMockups] = useState<DesignerMockupFile[]>([])
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
        inspirationDirectoryPath: INSPIRATION_DIRECTORY_NAME,
        uiDirectionPath: UI_DIRECTION_RELATIVE_PATH,
        mockupPath: PRIMARY_MOCKUP_RELATIVE_PATH,
      },
      {
        terminalApi: {
          terminalSpawn: window.api.terminalSpawn,
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

  // Watch the mockups directory for real .html files. Recursive so nested
  // designer outputs (e.g. mockups/dashboard/index.html) still flip readiness.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const refresh = async () => {
      try {
        const htmlFiles = await collectMockupHtmlFiles(
          mockupsDirectoryPath,
          MOCKUPS_DIRECTORY_NAME,
          0,
        )
        if (cancelled) return
        htmlFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        setMockups(htmlFiles)
      } catch {
        if (!cancelled) setMockups([])
      }
    }

    void refresh()
    void window.api
      .watchPath(mockupsDirectoryPath, () => {
        void refresh()
      })
      .then((stop) => {
        if (cancelled) {
          void stop()
          return
        }
        stopWatch = stop
      })
      .catch(() => {
        // The mockups directory may not exist yet; the poll below will keep
        // checking until it does.
      })

    // macOS fs.watch (fsevents) can miss "create" events for files added to a
    // directory that was empty when the watcher started. Poll as a fallback so
    // the designer-ready transition is not stuck on a missed event.
    const pollHandle = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(pollHandle)
      if (stopWatch) void stopWatch()
    }
  }, [enabled, mockupsDirectoryPath])

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
  }
}
