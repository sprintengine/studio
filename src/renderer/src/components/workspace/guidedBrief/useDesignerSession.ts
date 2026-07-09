import { useEffect, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import type { DesignSystemSeedSource, GuidedBriefRuntimeState } from '../../../types/workspace'
import {
  createGuidedBriefSessionId,
  guidedBriefSpecialistAgentId,
  startGuidedBriefSpecialistSession,
  GUIDED_BRIEF_DESIGN_SKILL_ID,
  type GuidedBriefSessionLifecycle,
  type GuidedBriefSpecialistSession,
} from './sessionAdapter'
import { startGuidedBriefConversationSession } from './conversationSessionAdapter'
import { DESIGN_SYSTEM_MANIFEST_FILENAME } from '../../../../../shared/design-system/manifest'
import { useStageLiveStatus } from './useStageLiveStatus'
import {
  designSystemArtifactsValid,
  frontendDesignArtifactsValid,
  isAgentQuiet,
  isStageReady,
  type StageLiveStatus,
} from './stageReadiness'
import {
  EMPTY_GUIDED_INTERVIEW_STATE,
  type GuidedInterviewState,
} from './interviewProtocol'
import { joinWorkspacePath } from './paths'
import {
  DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME,
  EMPTY_DESIGN_ARTIFACT_INDEX,
  INSPIRATION_DIRECTORY_NAME,
  MOCKUPS_DIRECTORY_NAME,
  SCAFFOLD_BASELINE_RELATIVE_PATH,
  UI_DIRECTION_RELATIVE_PATH,
  collectDesignArtifacts,
  designArtifactRootsForPreset,
  parseScaffoldBaseline,
  type DesignArtifactEntry,
  type DesignArtifactIndex,
  type DesignArtifactsStatus,
  type ScaffoldBaseline,
} from './designArtifacts'
import { DESIGN_SYSTEM_IDEA_SEED_RELATIVE_PATH } from '../../../utils/guidedBriefWorkspace'

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
  // Design-system preset: the session authors the portable bundle under its
  // dedicated role prompt, and the artifact index/watchers cover the
  // `design-system/` tree instead of `product/ui-direction.md`.
  designSystem?: boolean
  // Seed-from-existing-product source for the design-system preset; shapes
  // the designer prompt's opening move. Ignored when designSystem is false.
  designSystemSeedSource?: DesignSystemSeedSource | null
  // Persisted PTY id (survives renderer HMR / reload). When provided, the main
  // process reattaches to the existing session and replays its buffer.
  sessionId: string | null
  onAssignSessionId: (sessionId: string) => void
  // 'conversation' runs the specialist as a Claude conversation session
  // (structured question cards, no PTY); requires workspaceId.
  transport?: 'terminal' | 'conversation'
  workspaceId?: string
}

export type UseDesignerSessionResult = {
  status: DesignerSessionStatus
  error: string | null
  readiness: DesignerSessionReadiness
  /** Live specialist status from the transport's own session signal (MC-1503). */
  liveStatus: StageLiveStatus
  session: GuidedBriefSpecialistSession | null
  uiDirectionPath: string
  mockupsDirectoryPath: string
  mockups: DesignerMockupFile[]
  /** Full design-artifact index (pages, stylesheets, scripts, assets, notes, inspiration). */
  designArtifacts: DesignArtifactIndex
  designArtifactsStatus: DesignArtifactsStatus
  /** Structured interview parsed from the session stream (replay included). */
  interview: GuidedInterviewState
  /** Conversation transport only: recent streamed assistant text for the chat pane. */
  transcriptTail: string
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
  designSystem = false,
  designSystemSeedSource = null,
  sessionId,
  onAssignSessionId,
  transport = 'terminal',
  workspaceId,
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
  const [interview, setInterview] = useState<GuidedInterviewState>(EMPTY_GUIDED_INTERVIEW_STATE)
  const [transcriptTail, setTranscriptTail] = useState('')
  // design-system preset only: the bundle manifest parses AND the bundle lint
  // reports no findings, evaluated on quiet edges (see the validation effect).
  const [designSystemValid, setDesignSystemValid] = useState(false)

  const uiDirectionAbsolutePath = joinWorkspacePath(workspaceRoot, UI_DIRECTION_RELATIVE_PATH)
  const mockupsDirectoryPath = joinWorkspacePath(workspaceRoot, MOCKUPS_DIRECTORY_NAME)

  // Liveness from the transport's live session status (not "is output
  // streaming"): quiet gates readiness so a mid-write agent never flips the stage.
  const liveStatus = useStageLiveStatus({
    workspaceId,
    agentId: guidedBriefSpecialistAgentId(
      designSystem
        ? {
            kind: 'designer',
            designSystem: {
              bundleDirectoryPath: DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME,
              ideaSeedPath: DESIGN_SYSTEM_IDEA_SEED_RELATIVE_PATH,
            },
          }
        : { kind: 'designer' },
    ),
    transport,
    enabled,
  })
  const agentQuiet = isAgentQuiet(liveStatus)

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
    // Injection predicate for the attached-design-system prompt line, resolved
    // once per launch: `design-system/` exists in the workspace AND this is
    // not the authoring studio (which owns that directory as its product).
    const resolveDesignSystemAttached = async (): Promise<boolean> => {
      if (designSystem) return false
      return window.api
        .pathExists(joinWorkspacePath(workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME))
        .catch(() => false)
    }
    void resolveDesignSystemAttached().then((designSystemAttached) => {
      const sessionInput = {
        kind: 'designer' as const,
        workspaceRoot,
        // Also threaded into the PTY spawn metadata so the session manager
        // inventories the fallback-transport session.
        ...(workspaceId ? { workspaceId } : {}),
        acceptedBriefSnapshotPath,
        acceptedArchitecturePlanPath,
        sessionId: resolvedSessionId,
        cli,
        cliModel,
        inspirationDirectoryPath: INSPIRATION_DIRECTORY_NAME,
        uiDirectionPath: UI_DIRECTION_RELATIVE_PATH,
        mockupPath: PRIMARY_MOCKUP_RELATIVE_PATH,
        ...(designSystemAttached ? { designSystemAttached } : {}),
        ...(designSystem
          ? {
              designSystem: {
                bundleDirectoryPath: DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME,
                ideaSeedPath: DESIGN_SYSTEM_IDEA_SEED_RELATIVE_PATH,
                ...(designSystemSeedSource ? { seedSource: designSystemSeedSource } : {}),
              },
            }
          : {}),
      }
      const sessionCallbacks = {
        cliRuntimes,
        // Install the curated design skill into .claude/skills/ before the
        // session spawns. The adapter only invokes this for Claude designer
        // sessions (guidedBriefUsesDesignSkill); here it just performs the
        // install and swallows its result — the adapter handles failure.
        ensureDesignSkillInstalled: () =>
          window.api
            .builtinSkillInstall({ workspaceRoot, skillId: GUIDED_BRIEF_DESIGN_SKILL_ID })
            .then(() => undefined),
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
      return startPromise.then((result) => {
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
  // browsing and selection. Discovery is run-scoped (MC-1502): roots are
  // preset-scoped, and the shared-root presets filter pre-existing seed-repo
  // files via the scaffold baseline (loaded once — it is written exactly once,
  // at scaffold time; missing = legacy run, no filtering). Watch each indexed
  // root, plus a poll fallback because macOS fs.watch can miss create events
  // on a directory that was empty when the watcher started.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const stopWatchers: Array<() => Promise<void>> = []

    const roots = designArtifactRootsForPreset(designSystem ? 'design-system' : 'frontend-design')
    const baselinePromise: Promise<ScaffoldBaseline | null> = designSystem
      ? Promise.resolve(null)
      : window.api
          .readfile(joinWorkspacePath(workspaceRoot, SCAFFOLD_BASELINE_RELATIVE_PATH))
          .then((content) => parseScaffoldBaseline(content))
          .catch(() => null)

    // The poll fires every 2.5s and every watch event fires refresh again, so
    // two guards keep the hot loop cheap: (1) single-flight — a refresh that
    // arrives while one is walking coalesces into ONE trailing re-walk instead
    // of a walk per event (an agent writing a component fires several fs events
    // back-to-back), which also keeps index publishes ordered; (2) an identity
    // bailout — an index whose entries (path + mtime) are unchanged is dropped
    // instead of published, so the studio subtree does not re-render every tick.
    let refreshInFlight = false
    let refreshQueued = false
    let publishedSignature: string | null = null
    const indexSignature = (index: DesignArtifactIndex): string =>
      index.entries
        .map((entry) => `${entry.relativePath}::${entry.modifiedAtMs ?? 0}`)
        .join('|')

    const refresh = async () => {
      if (refreshInFlight) {
        refreshQueued = true
        return
      }
      refreshInFlight = true
      try {
        const rootExists = await window.api.pathExists(workspaceRoot)
        if (cancelled) return
        if (!rootExists) {
          publishedSignature = null
          setDesignArtifacts(EMPTY_DESIGN_ARTIFACT_INDEX)
          setMockups((previous) => (previous.length === 0 ? previous : []))
          setDesignArtifactsStatus('unavailable')
          return
        }
        const baseline = await baselinePromise
        const index = await collectDesignArtifacts(
          workspaceRoot,
          {
            readdir: window.api.readdir,
            pathExists: window.api.pathExists,
            statPath: window.api.statPath,
          },
          { roots, baseline },
        )
        if (cancelled) return
        const signature = indexSignature(index)
        if (signature !== publishedSignature) {
          publishedSignature = signature
          setDesignArtifacts(index)
          const pages = index.groups.find((group) => group.id === 'pages')?.entries ?? []
          setMockups(pages.map(toDesignerMockupFile))
        }
        setDesignArtifactsStatus('ready')
      } catch {
        if (!cancelled) {
          publishedSignature = null
          setDesignArtifacts(EMPTY_DESIGN_ARTIFACT_INDEX)
          setMockups((previous) => (previous.length === 0 ? previous : []))
          setDesignArtifactsStatus('unavailable')
        }
      } finally {
        refreshInFlight = false
        if (refreshQueued && !cancelled) {
          refreshQueued = false
          void refresh()
        }
      }
    }

    const watchDirectories = [
      ...(roots.mockups ? [mockupsDirectoryPath] : []),
      ...(roots.uiDirection ? [joinWorkspacePath(workspaceRoot, 'product')] : []),
      ...(roots.inspiration ? [joinWorkspacePath(workspaceRoot, INSPIRATION_DIRECTORY_NAME)] : []),
      ...(roots.designSystemBundle
        ? [joinWorkspacePath(workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME)]
        : []),
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
    // `markerReceived` re-runs discovery the moment the marker lands (marker
    // demoted to an extra validation trigger).
  }, [enabled, workspaceRoot, mockupsDirectoryPath, designSystem, markerReceived])

  // Watch product/ui-direction.md for non-empty content. Design-system
  // studios have no UI-direction artifact — readiness there is the marker or
  // real bundle pages, so the watcher (and its poll) never starts.
  useEffect(() => {
    if (!enabled || designSystem) return
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
    // `markerReceived` re-checks ui-direction the moment the marker lands.
  }, [enabled, uiDirectionAbsolutePath, workspaceRoot, designSystem, markerReceived])

  // design-system readiness contract (MC-1503): the bundle manifest parses AND
  // the real bundle lint returns no findings. Evaluated only on quiet edges —
  // when the agent goes quiet, and again when the marker lands — never on every
  // write (the lint forks a process). A mid-write agent, a malformed manifest,
  // or a deleted design-system.json all leave this false.
  useEffect(() => {
    if (!enabled || !designSystem || !agentQuiet) {
      setDesignSystemValid(false)
      return
    }
    let cancelled = false
    const bundleDir = joinWorkspacePath(workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME)
    const manifestPath = joinWorkspacePath(
      workspaceRoot,
      `${DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME}/${DESIGN_SYSTEM_MANIFEST_FILENAME}`,
    )
    const validate = async (): Promise<boolean> => {
      const content = await window.api.readfile(manifestPath).catch(() => null)
      let manifestParses = false
      if (content !== null) {
        try {
          JSON.parse(content)
          manifestParses = true
        } catch {
          manifestParses = false
        }
      }
      // Skip the fork when the manifest is missing/broken — nothing to lint.
      const lintClean = manifestParses
        ? Boolean((await window.api.lintDesignSystemBundle(bundleDir).catch(() => null))?.ok)
        : false
      return designSystemArtifactsValid({ manifestParses, lintClean })
    }
    void validate().then((valid) => {
      if (!cancelled) setDesignSystemValid(valid)
    })
    return () => {
      cancelled = true
    }
    // `markerReceived` re-runs the validation the moment the marker lands.
  }, [enabled, designSystem, agentQuiet, workspaceRoot, markerReceived])

  const mockupsAvailable = mockups.length > 0
  // Readiness = validated artifact set AND a quiet agent (MC-1503). The marker
  // is only a re-validation trigger, never a readiness signal, so a marker over
  // a broken/absent artifact set can't flip the stage. frontend-design needs a
  // real page AND a non-empty UI direction — a page alone no longer counts
  // (intended change from the old `mockupsAvailable`-alone rule). Accept remains
  // gated on real files only — see GuidedBriefFlow.acceptDesigner.
  const artifactsValid = designSystem
    ? designSystemValid
    : frontendDesignArtifactsValid({
        pageCount: mockups.length,
        uiDirectionNonEmpty: uiDirectionReady,
      })
  const isReady = isStageReady({ artifactsValid, agentQuiet })

  // Designer-turn completion edge: regenerate design-system derived files
  // (tokens.css, catalog) for any bundle in the workspace by running the
  // bundle's own generator scripts in a main-process utility fork. Workspaces
  // without a bundle (full-brief, frontend-design) resolve as a no-op, so
  // this fires the IPC once and otherwise leaves those flows untouched.
  const regenTriggeredRef = useRef(false)
  useEffect(() => {
    if (!enabled || !isReady || regenTriggeredRef.current) return
    regenTriggeredRef.current = true
    window.api
      .regenerateDesignSystemDerivedFiles(workspaceRoot)
      .then((result) => {
        if (!result.ok) {
          console.error('[design-system] derived-file regeneration failed', result)
        }
      })
      .catch((error) => {
        console.error('[design-system] derived-file regeneration failed', error)
      })
  }, [enabled, isReady, workspaceRoot])

  return {
    status,
    error,
    readiness: { markerReceived, mockupsAvailable, uiDirectionReady, isReady },
    liveStatus,
    session,
    uiDirectionPath: uiDirectionAbsolutePath,
    mockupsDirectoryPath,
    mockups,
    designArtifacts,
    designArtifactsStatus,
    interview,
    transcriptTail,
  }
}
