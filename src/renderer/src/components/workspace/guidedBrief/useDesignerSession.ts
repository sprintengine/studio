import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import {
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
  acceptedBriefSnapshotPath: string
  cli: AgentCli
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  enabled: boolean
}

export type UseDesignerSessionResult = {
  status: DesignerSessionStatus
  error: string | null
  readiness: DesignerSessionReadiness
  session: GuidedBriefSpecialistSession | null
  uiDirectionPath: string
  mockupsDirectoryPath: string
  inspirationDirectoryPath: string
  mockups: DesignerMockupFile[]
  primaryMockupRelativePath: string
}

const UI_DIRECTION_RELATIVE_PATH = 'product/ui-direction.md'
const MOCKUPS_DIRECTORY_NAME = 'mockups'
const INSPIRATION_DIRECTORY_NAME = '.guided-brief/inspiration'
const PRIMARY_MOCKUP_RELATIVE_PATH = 'mockups/app.html'

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

export function useDesignerSession({
  workspaceRoot,
  acceptedBriefSnapshotPath,
  cli,
  cliRuntimes,
  enabled,
}: UseDesignerSessionInput): UseDesignerSessionResult {
  const [status, setStatus] = useState<DesignerSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [markerReceived, setMarkerReceived] = useState(false)
  const [mockups, setMockups] = useState<DesignerMockupFile[]>([])
  const [uiDirectionReady, setUiDirectionReady] = useState(false)
  const [session, setSession] = useState<GuidedBriefSpecialistSession | null>(null)

  const uiDirectionAbsolutePath = joinWorkspacePath(workspaceRoot, UI_DIRECTION_RELATIVE_PATH)
  const mockupsDirectoryPath = joinWorkspacePath(workspaceRoot, MOCKUPS_DIRECTORY_NAME)
  const inspirationDirectoryPath = joinWorkspacePath(workspaceRoot, INSPIRATION_DIRECTORY_NAME)

  const startedRef = useRef(false)

  // Start the designer session once the consumer marks it enabled. The
  // accepted brief snapshot path is required and must already exist.
  useEffect(() => {
    if (!enabled) return
    if (startedRef.current) return
    startedRef.current = true

    let cancelled = false
    let activeSession: GuidedBriefSpecialistSession | null = null

    setStatus('starting')
    void startGuidedBriefSpecialistSession(
      {
        kind: 'designer',
        workspaceRoot,
        acceptedBriefSnapshotPath,
        cli,
        inspirationDirectoryPath: INSPIRATION_DIRECTORY_NAME,
        uiDirectionPath: UI_DIRECTION_RELATIVE_PATH,
        mockupPath: PRIMARY_MOCKUP_RELATIVE_PATH,
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

  // Watch the mockups directory for real .html files.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const refresh = async () => {
      try {
        const entries = await window.api.readdir(mockupsDirectoryPath).catch(() => [])
        if (cancelled) return
        const htmlFiles = entries
          .filter((entry) => !entry.isDir && /\.html?$/i.test(entry.name))
          .map<DesignerMockupFile>((entry) => ({
            name: entry.name,
            absolutePath: joinWorkspacePath(mockupsDirectoryPath, entry.name),
            relativePath: `${MOCKUPS_DIRECTORY_NAME}/${entry.name}`,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
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
        // The mockups directory may not exist yet; periodic refresh is not
        // required because the scaffold already created it before the
        // strategist accepted.
      })

    return () => {
      cancelled = true
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

    return () => {
      cancelled = true
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
    inspirationDirectoryPath,
    mockups,
    primaryMockupRelativePath: PRIMARY_MOCKUP_RELATIVE_PATH,
  }
}
