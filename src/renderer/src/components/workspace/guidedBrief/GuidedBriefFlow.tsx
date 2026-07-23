import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import type {
  SprintEngineCliPermissionPreset,
  SprintEngineAutomationMode,
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleRegistry,
} from '../../../types/workspace'
import {
  guidedBriefSnapshotSlug,
  snapshotGuidedBriefArtifact,
  GuidedBriefWorkspaceError,
  writeGuidedBriefBuildHandoff,
} from '../../../utils/guidedBriefWorkspace'
import { applyUserDisabledSprintEngineRoleCounts } from '../../../utils/sprintengine'
import { CloseIconButton, LifecycleGlyph, Tabs, Tooltip, TruncatedText, type TabItem } from '../../ui'
import { parentPath } from '../../../utils/paths'
import { RosterAndRunSettings } from '../newWorkspace/WizardControls'
import { ConversationPane } from './ConversationPane'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { HtmlArtifactFrame, MockupPreviewPane, humanizeFileTitle, pageTitleFromHtml } from './MockupPreviewPane'
import { designerAnnotationMessage } from './annotate/serialize'
import type { MockupAnnotation } from './annotate/types'
import { DesignArtifactPreviewPane } from './DesignArtifactPreviewPane'
import { ComponentGalleryPane } from './ComponentGalleryPane'
import { RenderedBriefPane } from './RenderedBriefPane'
import {
  CanvasStudio,
  canvasScreensFromIndex,
  type CanvasStudioNav,
  type DesignSystemViewMode,
} from './CanvasStudio'
import {
  applyDesignArtifactSelection,
  designSystemBundleFileCount,
  findDesignArtifact,
  DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME,
  type DesignArtifactEntry,
  type DesignArtifactIndex,
} from './designArtifacts'
import {
  canRelease,
  displayLibraryPath,
  initialReleaseVersion,
  isReleaseInFlight,
  isValidReleaseVersion,
  lintFixRequestMessage,
  lintIssueCountLabel,
  parseLintFindings,
  releaseButtonLabel,
  releaseDestinationDisplay,
  releasePhaseAfterLint,
  releasePhaseAfterRelease,
  releaseStatusLine,
  type DesignSystemReleasePhase,
} from './designSystemRelease'
import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  parseDesignSystemManifest,
} from '../../../../../shared/design-system/manifest'
import { useArchitectSession } from './useArchitectSession'
import {
  useDesignerSession,
  nextDesignerStageForReadiness,
  type DesignerMockupFile,
} from './useDesignerSession'
import { useStrategistSession } from './useStrategistSession'
import { basename, joinWorkspacePath } from './paths'
import {
  guidedBriefBuildHandoffRelativePath,
  guidedBriefHandoffChecklist,
  guidedBriefPlanningDecisionNotes,
  guidedBriefPlanningValidationNotes,
} from './handoff'
import {
  guidedBriefSkipToHandoffState,
  guidedBriefSteps,
  guidedBriefTransportForCli,
  mergeGuidedBriefDecisions,
  type GuidedBriefAcceptedArtifact,
  type GuidedBriefRuntimeState,
  type GuidedBriefStage,
  type GuidedBriefStepInfo,
} from './types'
import type { GuidedInterviewState } from './interviewProtocol'
import type { GuidedBriefSpecialistSession } from './sessionAdapter'
import { designSystemReadinessHint, type StageLiveStatus } from './stageReadiness'

export type GuidedBriefRunOptions = {
  startRunner: boolean
  autoApproveArtifacts: boolean
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  cliPermissionPreset: SprintEngineCliPermissionPreset
}

type Props = {
  runtimeState: GuidedBriefRuntimeState
  onChange: (next: GuidedBriefRuntimeState) => void
  // Enables the conversation transport for Claude specialists (their sessions
  // ride the shared ConversationRuntime, keyed by this workspace id). Absent →
  // legacy terminal transport for every role.
  workspaceId?: string
  onBackToIdea: () => void
  onClose?: () => void
  onStartBuild: (
    runtimeState: GuidedBriefRuntimeState,
    runOptions: GuidedBriefRunOptions,
  ) => Promise<void>
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  // Plugin-aware role CLI picker options, built by the parent from the installed
  // plugin catalog. `cliRuntimes` above stays for the session hooks, which need
  // the real launch command / WSL config, not just the selectable list.
  cliOptions: Array<{ value: AgentCli; label: string }>
  sprintEngineRoleRegistry?: SprintEngineRoleRegistry | null
  sprintEngineDisabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
}

export function GuidedBriefFlow({
  runtimeState,
  onChange,
  workspaceId,
  onBackToIdea,
  onClose,
  onStartBuild,
  cliRuntimes,
  cliOptions,
  sprintEngineRoleRegistry = null,
  sprintEngineDisabledRoleIds = null,
}: Props) {
  const { stage, hasUi, workspaceRoot, workspaceName, acceptedProductBrief, acceptedArchitecturePlan } = runtimeState

  // Designer-readiness race fix (T11). `onChange` is value-only and, in the
  // post-creation runtime, persists through the workspace store — so a functional
  // updater at the prop boundary is not an option. Instead, accumulate concurrent
  // patches through a ref: each effect-driven update merges onto the latest
  // patched state and advances the ref synchronously, so when the stage-flip,
  // active-mockup, and session-id effects fire in the same React commit the final
  // onChange carries all of them instead of clobbering each other with a stale
  // whole-runtime spread (which left the workspace stuck in `designer-working`).
  const runtimeStateRef = useRef(runtimeState)
  runtimeStateRef.current = runtimeState
  const updateRuntimeState = (
    updater: (prev: GuidedBriefRuntimeState) => GuidedBriefRuntimeState,
  ) => {
    const next = updater(runtimeStateRef.current)
    if (next === runtimeStateRef.current) return
    runtimeStateRef.current = next
    onChange(next)
  }

  const progressOptions = {
    wantsProductDiscussion: runtimeState.wantsProductDiscussion,
    wantsArchitectureDiscussion: runtimeState.wantsArchitectureDiscussion,
    wantsFrontendDiscussion: runtimeState.wantsFrontendDiscussion,
    preset: runtimeState.preset,
  }
  const steps = guidedBriefSteps(stage, hasUi, progressOptions)
  const inStrategistStage = stage === 'strategist-working' || stage === 'strategist-ready'
  const inArchitectStage = stage === 'architect-working' || stage === 'architect-ready'
  const inDesignerStage = stage === 'designer-working' || stage === 'designer-ready'

  // Transport per specialist CLI. Design specialists run on terminals by
  // default; the conversation transport (structured question cards, streamed
  // chat) is an experimental opt-in for Claude specialists, on only when the
  // user explicitly enabled it. Other CLIs always take the terminal path.
  const conversationSessionsEnabled = useWorkspaceStore(
    (s) => s.appSettings.guidedBriefConversationSessions === true,
  )
  const transportForCli = (cli: AgentCli): 'terminal' | 'conversation' =>
    guidedBriefTransportForCli(cli, {
      conversationSessionsEnabled,
      hasWorkspaceId: Boolean(workspaceId),
    })

  const strategist = useStrategistSession({
    workspaceRoot,
    cli: runtimeState.guidedRoleCliDefaults.product,
    cliModel: runtimeState.guidedRoleModelOverrides?.product ?? undefined,
    cliRuntimes,
    enabled: inStrategistStage,
    transport: transportForCli(runtimeState.guidedRoleCliDefaults.product),
    workspaceId,
    sessionId: runtimeState.strategistSessionId,
    onAssignSessionId: (id) => {
      updateRuntimeState((prev) =>
        prev.strategistSessionId === id ? prev : { ...prev, strategistSessionId: id },
      )
    },
  })

  const acceptedBriefRelativePath = acceptedProductBrief?.path ?? null
  const architect = useArchitectSession({
    workspaceRoot,
    acceptedBriefSnapshotPath: acceptedBriefRelativePath,
    cli: runtimeState.guidedRoleCliDefaults.architect,
    cliModel: runtimeState.guidedRoleModelOverrides?.architect ?? undefined,
    cliRuntimes,
    enabled: inArchitectStage,
    transport: transportForCli(runtimeState.guidedRoleCliDefaults.architect),
    workspaceId,
    sessionId: runtimeState.architectSessionId,
    onAssignSessionId: (id) => {
      updateRuntimeState((prev) =>
        prev.architectSessionId === id ? prev : { ...prev, architectSessionId: id },
      )
    },
  })

  // The designer prefers the accepted architecture plan, then the product
  // brief, then the idea seed. The PTY cwd is workspaceRoot, so prompt paths
  // stay project-relative for the agent.
  const acceptedArchitecturePlanRelativePath = acceptedArchitecturePlan?.path ?? null
  const designer = useDesignerSession({
    workspaceRoot,
    acceptedBriefSnapshotPath: acceptedBriefRelativePath ?? undefined,
    acceptedArchitecturePlanPath: acceptedArchitecturePlanRelativePath,
    cli: runtimeState.guidedRoleCliDefaults.frontend,
    cliModel: runtimeState.guidedRoleModelOverrides?.frontend ?? undefined,
    cliRuntimes,
    enabled:
      hasUi === 'yes' &&
      runtimeState.wantsFrontendDiscussion &&
      inDesignerStage,
    designSystem: runtimeState.preset === 'design-system',
    designSystemSeedSource: runtimeState.designSystemSeedSource ?? null,
    transport: transportForCli(runtimeState.guidedRoleCliDefaults.frontend),
    workspaceId,
    sessionId: runtimeState.designerSessionId,
    onAssignSessionId: (id) => {
      updateRuntimeState((prev) =>
        prev.designerSessionId === id ? prev : { ...prev, designerSessionId: id },
      )
    },
  })

  // Stage and selection effects below use functional `onChange` updaters rather
  // than spreading the closure's `runtimeState`. When several of these fire in
  // one React commit (e.g. mockups appear → readiness flips, the active mockup
  // is selected, and the designer session id is assigned at once), a stale
  // whole-runtime spread made the later value-update clobber the others and
  // strand the workspace in `designer-working`. Each updater re-checks against
  // the latest `prev` and returns a narrow patch (or `prev` unchanged).

  // Strategist working → ready as soon as a real signal arrives.
  useEffect(() => {
    if (stage === 'strategist-working' && strategist.readiness.isReady) {
      updateRuntimeState((prev) =>
        prev.stage === 'strategist-working' ? { ...prev, stage: 'strategist-ready' } : prev,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, strategist.readiness.isReady])

  useEffect(() => {
    if (stage === 'architect-working' && architect.readiness.isReady) {
      updateRuntimeState((prev) =>
        prev.stage === 'architect-working' ? { ...prev, stage: 'architect-ready' } : prev,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, architect.readiness.isReady])

  // Designer working → ready as soon as real mockup files exist (or marker +
  // files). Real file presence is the contractual gate; marker alone is a hint.
  useEffect(() => {
    if (stage === 'designer-working' && designer.readiness.isReady) {
      updateRuntimeState((prev) => nextDesignerStageForReadiness(prev, true))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, designer.readiness.isReady])

  // Track the active mockup in runtime state once mockups appear, so the
  // preview pane has a stable selection across re-renders.
  useEffect(() => {
    if (!designer.mockups.length) return
    const available = new Set(designer.mockups.map((m) => m.relativePath))
    const firstMockupPath = designer.mockups[0].relativePath
    updateRuntimeState((prev) =>
      prev.activeMockupPath && available.has(prev.activeMockupPath)
        ? prev
        : { ...prev, activeMockupPath: firstMockupPath },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designer.mockups])

  // The designer studio should open on a useful artifact as soon as files
  // exist (both presets — the studio shell is shared). Prefer the first HTML
  // page, then any available artifact, and repair the selection if the
  // previously selected file is deleted.
  useEffect(() => {
    const entries = designer.designArtifacts.entries
    if (!entries.length) return
    updateRuntimeState((prev) => {
      if (
        prev.activeDesignArtifactPath &&
        entries.some((entry) => entry.relativePath === prev.activeDesignArtifactPath)
      ) {
        return prev
      }
      const nextEntry = entries.find((entry) => entry.kind === 'page') ?? entries[0]
      return applyDesignArtifactSelection(prev, nextEntry)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designer.designArtifacts])

  // Persist resolved interview decisions per role so the build handoff can
  // carry the real decision record. Merge is dedupe-by-id and returns `prev`
  // unchanged when nothing new arrived.
  useEffect(() => {
    updateRuntimeState((prev) => mergeGuidedBriefDecisions(prev, 'product', strategist.interview.decisions))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategist.interview.decisions])
  useEffect(() => {
    updateRuntimeState((prev) => mergeGuidedBriefDecisions(prev, 'architect', architect.interview.decisions))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [architect.interview.decisions])
  useEffect(() => {
    updateRuntimeState((prev) => mergeGuidedBriefDecisions(prev, 'frontend', designer.interview.decisions))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designer.interview.decisions])

  // Stops a specialist session through the transport its persisted id belongs
  // to: conversation session ids are runtime-minted (`conv_…`), PTY ids are
  // wizard-minted uuids. Both calls no-op harmlessly on an unknown id.
  const stopSpecialistSessionById = (sessionId: string) => {
    if (sessionId.startsWith('conv_')) {
      void window.api.conversationSessionStop({ sessionId }).catch(() => {})
      return
    }
    void window.api.terminalKill(sessionId).catch(() => {})
  }

  // Answers a question card through the session's own transport: a structured
  // conversation respond, or PTY stdin keystrokes (same as typing).
  const answerViaSession = (session: GuidedBriefSpecialistSession | null) => (text: string): boolean | Promise<boolean> => {
    if (!session) return false
    if (session.transport === 'conversation') {
      // Propagate delivery: a false resolution unlocks the question card so
      // the user can retry instead of the answer silently vanishing.
      return session.answer?.(text) ?? false
    }
    window.api.terminalWriteFast(session.sessionId, `${text}\r`)
    return true
  }

  // Read-only review of an already-accepted step, entered from the step rail.
  // Component-local on purpose: a reload lands back on the current step.
  const [reviewingStage, setReviewingStage] = useState<GuidedBriefStage | null>(null)
  useEffect(() => {
    setReviewingStage(null)
  }, [stage])
  const canReviewStep = (stepStage: GuidedBriefStage): boolean => {
    if (stepStage === 'strategist-working') return Boolean(runtimeState.acceptedProductBrief)
    if (stepStage === 'architect-working') return Boolean(runtimeState.acceptedArchitecturePlan)
    if (stepStage === 'designer-working') return runtimeState.acceptedMockups.length > 0
    return false
  }
  const reviewing = reviewingStage !== null && canReviewStep(reviewingStage)

  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [startingBuild, setStartingBuild] = useState(false)
  const [startBuildError, setStartBuildError] = useState<string | null>(null)
  const [skippingPlanning, setSkippingPlanning] = useState(false)
  const [skipError, setSkipError] = useState<string | null>(null)
  // Design-system release action ("Save as design system"). The phase is
  // derived from observed IPC results only — see designSystemRelease.ts.
  // `releaseVersionDraft` is null until the user types, so the input follows
  // the last released version (prefill-to-bump) without an effect.
  const [releasePhase, setReleasePhase] = useState<DesignSystemReleasePhase>({ kind: 'idle' })
  const [releaseVersionDraft, setReleaseVersionDraft] = useState<string | null>(null)
  const automationMode: SprintEngineAutomationMode = runtimeState.buildAutoApproveArtifacts
    ? 'run_agents_and_approve_artifacts'
    : runtimeState.buildStartRunner
      ? 'run_agents'
      : 'manual'
  const effectiveAutoApprove = automationMode === 'run_agents_and_approve_artifacts'

  // The design-only studio presets (frontend-design and design-system)
  // surface the real design-file index. Selecting a file persists its relative
  // path to the runtime state via the existing onChange path; HTML pages
  // mirror to activeMockupPath so the existing mockup preview stays in sync.
  // The design-system preset shares the same three-pane shell but authors the
  // portable bundle: no Sprint Engine build tail (its release action is a
  // separate epic task), so the footer drops the build-flow controls.
  const isDesignSystemPreset = runtimeState.preset === 'design-system'
  const isDesignPreset = runtimeState.preset === 'frontend-design' || isDesignSystemPreset
  const handleSelectDesignArtifact = (entry: DesignArtifactEntry) => {
    updateRuntimeState((prev) => applyDesignArtifactSelection(prev, entry))
  }

  const acceptStrategistBrief = async () => {
    if (!strategist.readiness.fileReady) return
    setAccepting(true)
    setAcceptError(null)
    try {
      const snapshot = await snapshotGuidedBriefArtifact({
        workspaceRoot,
        sourcePath: strategist.requirementsPath,
        kind: 'product',
        slug: 'product-brief',
        filesystem: {
          ensureDir: window.api.ensureDir,
          readFile: window.api.readfile,
          writeFile: window.api.writefile,
        },
      })
      const accepted: GuidedBriefAcceptedArtifact = {
        kind: 'product',
        title: 'Product brief',
        hash: snapshot.hash,
        path: snapshot.path,
      }
      // The HTML overview is optional — a view of the brief, never a gate.
      // Snapshot it when present; a failure must not block the accept.
      let acceptedOverview: GuidedBriefAcceptedArtifact | null = null
      if (strategist.overviewFileReady) {
        try {
          const overviewSnapshot = await snapshotGuidedBriefArtifact({
            workspaceRoot,
            sourcePath: strategist.overviewPath,
            kind: 'overview',
            slug: 'product-overview',
            filesystem: {
              ensureDir: window.api.ensureDir,
              readFile: window.api.readfile,
              writeFile: window.api.writefile,
            },
          })
          acceptedOverview = {
            kind: 'product',
            title: 'Product overview',
            hash: overviewSnapshot.hash,
            path: overviewSnapshot.path,
          }
        } catch {
          acceptedOverview = null
        }
      }
      const nextStage = nextGuidedBriefStage({ ...runtimeState, acceptedProductBrief: accepted }, 'strategist')
      // The strategist's job is done — kill the PTY and clear the persisted id
      // so it does not reattach on the next render.
      const strategistSessionIdToKill = runtimeState.strategistSessionId
      const nextState = {
        ...runtimeState,
        stage: nextStage,
        acceptedProductBrief: accepted,
        acceptedProductOverview: acceptedOverview,
        strategistSessionId: null,
      }
      if (nextStage === 'handoff') {
        await writeGuidedBriefBuildHandoff({
          workspaceRoot,
          idea: runtimeState.idea,
          hasUi,
          productBrief: accepted,
          architecturePlan: runtimeState.acceptedArchitecturePlan,
          productOverview: acceptedOverview,
          architectureOverview: runtimeState.acceptedArchitectureOverview,
          requireMockups: false,
          confirmedDecisions: [
            hasUi === 'yes'
              ? 'Application includes a visual UI, but no frontend design stage was requested.'
              : 'No visual UI is required.',
          ],
          recordedDecisions: runtimeState.guidedDecisions,
          filesystem: {
            ensureDir: window.api.ensureDir,
            readFile: window.api.readfile,
            writeFile: window.api.writefile,
          },
        })
      }
      onChange(nextState)
      if (strategistSessionIdToKill) {
        stopSpecialistSessionById(strategistSessionIdToKill)
      }
    } catch (error) {
      setAcceptError(formatAcceptError(error, 'brief'))
    } finally {
      setAccepting(false)
    }
  }

  const acceptArchitectPlan = async () => {
    if (!architect.readiness.fileReady) return
    setAccepting(true)
    setAcceptError(null)
    try {
      const snapshot = await snapshotGuidedBriefArtifact({
        workspaceRoot,
        sourcePath: architect.architecturePlanPath,
        kind: 'product',
        slug: 'architecture-plan',
        directory: 'architecture',
        filesystem: {
          ensureDir: window.api.ensureDir,
          readFile: window.api.readfile,
          writeFile: window.api.writefile,
        },
      })
      const accepted: GuidedBriefAcceptedArtifact = {
        kind: 'product',
        title: 'Architecture plan',
        hash: snapshot.hash,
        path: snapshot.path,
      }
      // Optional HTML overview — snapshot when present, never a gate.
      let acceptedOverview: GuidedBriefAcceptedArtifact | null = null
      if (architect.overviewFileReady) {
        try {
          const overviewSnapshot = await snapshotGuidedBriefArtifact({
            workspaceRoot,
            sourcePath: architect.overviewPath,
            kind: 'overview',
            slug: 'architecture-overview',
            directory: 'architecture',
            filesystem: {
              ensureDir: window.api.ensureDir,
              readFile: window.api.readfile,
              writeFile: window.api.writefile,
            },
          })
          acceptedOverview = {
            kind: 'product',
            title: 'Architecture overview',
            hash: overviewSnapshot.hash,
            path: overviewSnapshot.path,
          }
        } catch {
          acceptedOverview = null
        }
      }
      const nextStage = nextGuidedBriefStage({ ...runtimeState, acceptedArchitecturePlan: accepted }, 'architect')
      const architectSessionIdToKill = runtimeState.architectSessionId
      const nextState = {
        ...runtimeState,
        stage: nextStage,
        acceptedArchitecturePlan: accepted,
        acceptedArchitectureOverview: acceptedOverview,
        architectSessionId: null,
      }
      if (nextStage === 'handoff') {
        await writeGuidedBriefBuildHandoff({
          workspaceRoot,
          idea: runtimeState.idea,
          hasUi,
          productBrief: runtimeState.acceptedProductBrief,
          architecturePlan: accepted,
          productOverview: runtimeState.acceptedProductOverview,
          architectureOverview: acceptedOverview,
          requireMockups: false,
          confirmedDecisions: [
            hasUi === 'yes' ? 'Application includes a visual UI.' : 'No visual UI is required.',
          ],
          recordedDecisions: runtimeState.guidedDecisions,
          validationNotes: ['Validate implementation against the accepted architecture plan snapshot hash.'],
          filesystem: {
            ensureDir: window.api.ensureDir,
            readFile: window.api.readfile,
            writeFile: window.api.writefile,
          },
        })
      }
      onChange(nextState)
      if (architectSessionIdToKill) {
        stopSpecialistSessionById(architectSessionIdToKill)
      }
    } catch (error) {
      setAcceptError(formatAcceptError(error, 'plan'))
    } finally {
      setAccepting(false)
    }
  }

  const acceptDesignerMockups = async () => {
    // Real-file evidence: every mockup file in mockups/ is snapshotted.
    if (!designer.readiness.mockupsAvailable) return
    if (!runtimeState.acceptedProductBrief && runtimeState.wantsProductDiscussion) {
      setAcceptError('Accept the product brief before accepting mockups.')
      return
    }
    setAccepting(true)
    setAcceptError(null)
    try {
      const acceptedMockups: GuidedBriefAcceptedArtifact[] = []
      const uiDirectionSnapshot = await snapshotGuidedBriefArtifact({
        workspaceRoot,
        sourcePath: designer.uiDirectionPath,
        kind: 'product',
        slug: 'ui-direction',
        filesystem: {
          ensureDir: window.api.ensureDir,
          readFile: window.api.readfile,
          writeFile: window.api.writefile,
        },
      })
      const acceptedUiDirection: GuidedBriefAcceptedArtifact = {
        kind: 'product',
        title: 'UI direction',
        hash: uiDirectionSnapshot.hash,
        path: uiDirectionSnapshot.path,
      }
      for (const mockup of designer.mockups) {
        const snapshot = await snapshotGuidedBriefArtifact({
          workspaceRoot,
          sourcePath: mockup.absolutePath,
          kind: 'mockup',
          slug: guidedBriefSnapshotSlug(mockup.name.replace(/\.html?$/i, '')),
          filesystem: {
            ensureDir: window.api.ensureDir,
            readFile: window.api.readfile,
            writeFile: window.api.writefile,
          },
        })
        acceptedMockups.push({
          kind: 'mockup',
          title: titleForMockup(mockup),
          hash: snapshot.hash,
          path: snapshot.path,
        })
      }
      await writeGuidedBriefBuildHandoff({
        workspaceRoot,
        idea: runtimeState.idea,
        hasUi,
        productBrief: runtimeState.acceptedProductBrief,
        architecturePlan: runtimeState.acceptedArchitecturePlan,
        uiDirection: acceptedUiDirection,
        mockups: acceptedMockups,
        productOverview: runtimeState.acceptedProductOverview,
        architectureOverview: runtimeState.acceptedArchitectureOverview,
        requireMockups: true,
        confirmedDecisions: ['Application includes a visual UI.'],
        recordedDecisions: runtimeState.guidedDecisions,
        validationNotes: ['Validate implementation against the accepted brief, UI direction, and mockup snapshot hashes.'],
        filesystem: {
          ensureDir: window.api.ensureDir,
          readFile: window.api.readfile,
          writeFile: window.api.writefile,
        },
      })
      // The designer's job is done — kill the PTY and clear the persisted id.
      const designerSessionIdToKill = runtimeState.designerSessionId
      onChange({
        ...runtimeState,
        stage: 'handoff',
        acceptedUiDirection,
        acceptedMockups,
        designerSessionId: null,
      })
      if (designerSessionIdToKill) {
        stopSpecialistSessionById(designerSessionIdToKill)
      }
    } catch (error) {
      setAcceptError(formatAcceptError(error, 'mockup'))
    } finally {
      setAccepting(false)
    }
  }

  // The design-system studio has no build tail: authoring continues in place
  // and the release card floating over the canvas is the completion surface
  // (the approved "release card → canvas overlay" placement, MC-1505 §4).
  // Version prefill: last released version (bump to re-release), or 1.0.0 for
  // a first release.
  const releaseVersion =
    releaseVersionDraft ?? initialReleaseVersion(runtimeState.designSystemLastRelease ?? null)
  const releaseArmed = canRelease({
    phase: releasePhase,
    designerReady: designer.readiness.isReady,
    version: releaseVersion,
  })

  // Destination line identity: the bundle manifest's real name, read when the
  // stage reaches ready (readiness itself proved the manifest parses — see
  // useDesignerSession's design-system contract). Unknown name → the card
  // omits the destination rather than invent one.
  const designSystemReady = isDesignSystemPreset && designer.readiness.isReady
  const [bundleName, setBundleName] = useState<string | null>(null)
  useEffect(() => {
    if (!designSystemReady) return
    let cancelled = false
    const manifestPath = joinWorkspacePath(
      workspaceRoot,
      `${DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME}/${DESIGN_SYSTEM_MANIFEST_FILENAME}`,
    )
    void window.api
      .readfile(manifestPath)
      .then((content) => {
        if (cancelled) return
        try {
          setBundleName(parseDesignSystemManifest(content).name)
        } catch {
          setBundleName(null)
        }
      })
      .catch(() => {
        if (!cancelled) setBundleName(null)
      })
    return () => {
      cancelled = true
    }
  }, [designSystemReady, workspaceRoot])

  // Blocked-card primary action: the lint findings go to the designer as one
  // message (the user never hand-fixes bundle files). Sending hands the queue
  // to the designer, so the card returns to idle for the next attempt; a
  // delivery failure surfaces as an explicit error phase.
  const askDesignerToFixLint = () => {
    if (releasePhase.kind !== 'lint-failed') return
    const session = designer.session
    if (!session) return
    const message = lintFixRequestMessage(releasePhase.findings, session.transport)
    if (session.transport === 'conversation') {
      void window.api
        .conversationSessionSendTurn({ sessionId: session.sessionId, message })
        .then((result) => {
          if (!result.ok) {
            setReleasePhase({
              kind: 'error',
              message: `Could not send the lint findings to the designer. ${result.message}`,
            })
          }
        })
        .catch(() => {
          setReleasePhase({
            kind: 'error',
            message: 'Could not send the lint findings to the designer.',
          })
        })
    } else {
      window.api.terminalWriteFast(session.sessionId, `${message}\r`)
    }
    setReleasePhase({ kind: 'idle' })
  }

  const releaseDesignSystem = async () => {
    if (!releaseArmed) return
    const bundleDir = joinWorkspacePath(workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME)
    setReleasePhase({ kind: 'validating' })
    try {
      const afterLint = releasePhaseAfterLint(await window.api.lintDesignSystemBundle(bundleDir))
      setReleasePhase(afterLint)
      if (afterLint.kind !== 'releasing') return
      const after = releasePhaseAfterRelease(
        await window.api.releaseDesignSystemBundle(bundleDir, releaseVersion.trim()),
      )
      setReleasePhase(after)
      if (after.kind === 'released') {
        updateRuntimeState((prev) => ({ ...prev, designSystemLastRelease: after.release }))
        // Follow the new last release again so the next prefill is bump-ready.
        setReleaseVersionDraft(null)
      }
    } catch (error) {
      setReleasePhase({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not release the design system.',
      })
    }
  }

  // The design-system release action lives on the canvas (release card), not
  // in the footer — only in the ready state, per the approved mockup: before
  // that there is nothing lint-clean to save, and the footer hint says so.
  const releaseCard = designSystemReady ? (
    <DesignSystemReleaseCard
      phase={releasePhase}
      version={releaseVersion}
      armed={releaseArmed}
      bundleName={bundleName}
      designerSessionLive={designer.session !== null}
      onChangeVersion={(value) => setReleaseVersionDraft(value)}
      onRelease={() => void releaseDesignSystem()}
      onAskDesigner={askDesignerToFixLint}
    />
  ) : null

  const primaryAction = isDesignSystemPreset
    ? null
    : renderPrimaryAction({
        stage,
        accepting,
        startingBuild,
        strategist,
        architect,
        designer,
        onAcceptStrategist: () => void acceptStrategistBrief(),
        onAcceptArchitect: () => void acceptArchitectPlan(),
        onAcceptDesigner: () => void acceptDesignerMockups(),
        onStartBuild: () => void startBuild(),
      })

  const skipToRoster = async () => {
    if (stage === 'handoff') return
    setSkippingPlanning(true)
    setSkipError(null)
    try {
      const nextState = guidedBriefSkipToHandoffState(runtimeState)
      await writeGuidedBriefBuildHandoff({
        workspaceRoot,
        idea: runtimeState.idea,
        hasUi,
        productBrief: runtimeState.acceptedProductBrief,
        architecturePlan: runtimeState.acceptedArchitecturePlan,
        uiDirection: runtimeState.acceptedUiDirection,
        mockups: runtimeState.acceptedMockups,
        productOverview: runtimeState.acceptedProductOverview,
        architectureOverview: runtimeState.acceptedArchitectureOverview,
        requireMockups: false,
        confirmedDecisions: guidedBriefPlanningDecisionNotes(nextState),
        recordedDecisions: runtimeState.guidedDecisions,
        validationNotes: guidedBriefPlanningValidationNotes(nextState),
        filesystem: {
          ensureDir: window.api.ensureDir,
          readFile: window.api.readfile,
          writeFile: window.api.writefile,
        },
      })
      const sessionsToKill = [
        runtimeState.strategistSessionId,
        runtimeState.architectSessionId,
        runtimeState.designerSessionId,
      ].filter((id): id is string => Boolean(id))
      onChange(nextState)
      sessionsToKill.forEach((sessionId) => {
        stopSpecialistSessionById(sessionId)
      })
    } catch (error) {
      setSkipError(error instanceof Error ? error.message : 'Could not skip to the roster.')
    } finally {
      setSkippingPlanning(false)
    }
  }

  const startBuild = async () => {
    if (stage !== 'handoff') return
    setStartingBuild(true)
    setStartBuildError(null)
    try {
      await onStartBuild(runtimeState, {
        startRunner: runtimeState.buildStartRunner,
        autoApproveArtifacts: effectiveAutoApprove,
        roleCounts: runtimeState.buildRoleCounts,
        roleCliDefaults: runtimeState.buildRoleCliDefaults,
        cliPermissionPreset: runtimeState.buildCliPermissionPreset,
      })
    } catch (error) {
      setStartBuildError(error instanceof Error ? error.message : 'Could not start the build.')
    } finally {
      setStartingBuild(false)
    }
  }

  return (
    <section
      aria-labelledby="guided-brief-title"
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--bg-surface-raised)] px-5 py-3">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <h2
            id="guided-brief-title"
            className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]"
          >
            {workspaceName}
          </h2>
          <span className="text-[12px] text-[color:var(--text-muted)]">
            · {isDesignSystemPreset
              ? 'Design system'
              : isDesignPreset
                ? 'Design only'
                : `Plan & design${hasUi === 'no' ? ' · no UI' : ''}`}
          </span>
        </div>
        <StepRail
          steps={steps}
          canReview={canReviewStep}
          reviewingStage={reviewingStage}
          onReview={(stepStage) =>
            setReviewingStage((current) => (current === stepStage ? null : stepStage))
          }
        />
        {onClose ? (
          <CloseIconButton
            size="md"
            aria-label="Close"
            onClick={onClose}
            className="ml-2"
          />
        ) : null}
      </header>

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {reviewing && reviewingStage ? (
          <ReviewBody runtimeState={runtimeState} family={reviewingStage} />
        ) : inStrategistStage ? (
          <StrategistBody
            stage={stage}
            session={strategist.session}
            starting={strategist.status === 'starting' || strategist.status === 'idle'}
            errorMessage={strategist.error}
            working={stage === 'strategist-working'}
            liveStatus={strategist.liveStatus}
            fileReady={strategist.readiness.fileReady}
            overviewPath={strategist.overviewPath}
            overviewFileReady={strategist.overviewFileReady}
            interview={strategist.interview}
            onAnswer={answerViaSession(strategist.session)}
            transcriptTail={strategist.transcriptTail}
            requirementsPath={strategist.requirementsPath}
            productDirectoryPath={joinWorkspacePath(workspaceRoot, 'product')}
          />
        ) : inArchitectStage ? (
          <ArchitectBody
            stage={stage}
            session={architect.session}
            starting={architect.status === 'starting' || architect.status === 'idle'}
            errorMessage={architect.error}
            working={stage === 'architect-working'}
            liveStatus={architect.liveStatus}
            fileReady={architect.readiness.fileReady}
            overviewPath={architect.overviewPath}
            overviewFileReady={architect.overviewFileReady}
            interview={architect.interview}
            onAnswer={answerViaSession(architect.session)}
            transcriptTail={architect.transcriptTail}
            architecturePlanPath={architect.architecturePlanPath}
            architectureDirectoryPath={joinWorkspacePath(workspaceRoot, 'architecture')}
          />
        ) : inDesignerStage ? (
          <DesignStudioBody
            session={designer.session}
            starting={designer.status === 'starting' || designer.status === 'idle'}
            errorMessage={designer.error}
            working={stage === 'designer-working'}
            liveStatus={designer.liveStatus}
            ready={designer.readiness.isReady}
            interview={designer.interview}
            onAnswer={answerViaSession(designer.session)}
            transcriptTail={designer.transcriptTail}
            mockupCount={designer.mockups.length}
            designSystem={isDesignSystemPreset}
            designArtifacts={designer.designArtifacts}
            activeDesignArtifactPath={runtimeState.activeDesignArtifactPath ?? null}
            onSelectDesignArtifact={handleSelectDesignArtifact}
            releaseCard={releaseCard}
          />
        ) : (
          <HandoffBody
            runtimeState={runtimeState}
            onChange={onChange}
            cliOptions={cliOptions}
            sprintEngineRoleRegistry={sprintEngineRoleRegistry}
            sprintEngineDisabledRoleIds={sprintEngineDisabledRoleIds}
          />
        )}
      </main>

      <footer className="flex shrink-0 items-center gap-3 border-t border-[color:var(--bg-surface-raised)] px-5 py-3">
        {reviewing && reviewingStage ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--text-subtle)]">
              Reviewing an accepted artifact. The current step keeps running.
            </span>
            <SecondaryButton onClick={() => setReviewingStage(null)} disabled={false}>
              Back to current step
            </SecondaryButton>
          </>
        ) : (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-3">
              {stage === 'designer-working' || stage === 'designer-ready' ? (
                <DesignerReadinessHint
                  readiness={designer.readiness}
                  designSystem={isDesignSystemPreset}
                />
              ) : null}
              {acceptError ? (
                <TruncatedText as="span" text={acceptError} className="text-[12px] text-[color:var(--tone-error)]" />
              ) : null}
              {startBuildError ? (
                <TruncatedText as="span" text={startBuildError} className="text-[12px] text-[color:var(--tone-error)]" />
              ) : null}
              {skipError ? (
                <TruncatedText as="span" text={skipError} className="text-[12px] text-[color:var(--tone-error)]" />
              ) : null}
            </span>
            <button
              type="button"
              onClick={onBackToIdea}
              className="
                inline-flex h-9 items-center rounded-md px-3 text-[12px] font-medium text-[color:var(--text-default)]
                transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              "
            >
              Back
            </button>
            {stage !== 'handoff' && !isDesignSystemPreset ? (
              <SecondaryButton onClick={() => void skipToRoster()} disabled={skippingPlanning}>
                {skippingPlanning ? 'Skipping…' : 'Skip to roster'}
              </SecondaryButton>
            ) : null}
            {primaryAction}
          </>
        )}
      </footer>
    </section>
  )
}

function formatAcceptError(error: unknown, kind: 'brief' | 'plan' | 'mockup'): string {
  if (error instanceof GuidedBriefWorkspaceError) {
    switch (error.code) {
      case 'missing-source':
        return `Could not save the ${kind} snapshot. The source file is missing or empty — ask the specialist to rewrite it, then accept again. (${error.code})`
      case 'missing-root':
      case 'missing-idea':
        return `Could not save the ${kind} snapshot. The workspace state is incomplete — reopen the workspace and try again. (${error.code})`
      case 'missing-crypto':
        return `Could not save the ${kind} snapshot. Content hashing is unavailable in this environment — restart the app and try again. (${error.code})`
      case 'mockups-required':
        return `Could not write the build handoff. No mockups have been accepted — accept the design first. (${error.code})`
    }
  }
  if (error instanceof Error) return error.message
  return `Could not save the ${kind} snapshot.`
}

function titleForMockup(mockup: DesignerMockupFile): string {
  const base = mockup.name.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim()
  return base ? base.replace(/\b\w/g, (char) => char.toUpperCase()) : mockup.name
}

function nextGuidedBriefStage(
  state: GuidedBriefRuntimeState,
  completed: 'strategist' | 'architect' | 'designer' | 'none',
): GuidedBriefStage {
  if (completed === 'none' && state.wantsProductDiscussion) return 'strategist-working'
  if (
    completed !== 'architect' &&
    state.wantsArchitectureDiscussion &&
    !state.acceptedArchitecturePlan
  ) {
    return 'architect-working'
  }
  if (
    completed !== 'designer' &&
    state.hasUi === 'yes' &&
    state.wantsFrontendDiscussion &&
    state.acceptedMockups.length === 0
  ) {
    return 'designer-working'
  }
  return 'handoff'
}

// Labeled step rail: the four stations of the flow by name. Completed steps
// with an accepted artifact are clickable and open a read-only review.
function StepRail({
  steps,
  canReview,
  reviewingStage,
  onReview,
}: {
  steps: GuidedBriefStepInfo[]
  canReview: (stage: GuidedBriefStage) => boolean
  reviewingStage: GuidedBriefStage | null
  onReview: (stage: GuidedBriefStage) => void
}) {
  return (
    <nav
      aria-label="Design Wizard steps"
      className="ml-auto flex min-w-0 shrink-0 items-center gap-1"
    >
      {steps.map((step, index) => {
        const reviewable = step.state === 'done' && canReview(step.stage)
        const isReviewing = reviewingStage === step.stage
        return (
          <Fragment key={step.stage}>
            {index > 0 ? (
              <span
                aria-hidden="true"
                className="h-px w-3 shrink-0 bg-[color:var(--border-default)]"
              />
            ) : null}
            <button
              type="button"
              disabled={!reviewable}
              aria-current={step.state === 'active' ? 'step' : undefined}
              onClick={() => onReview(step.stage)}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)] ${
                step.state === 'active'
                  ? 'bg-[color:var(--accent-primary-soft)] font-medium text-[color:var(--text-strong)]'
                  : isReviewing
                    ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
                    : reviewable
                      ? 'cursor-pointer text-[color:var(--text-muted)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]'
                      : 'cursor-default text-[color:var(--text-subtle)]'
              }`}
            >
              {step.state === 'done' ? <LifecycleGlyph state="done" live={false} /> : null}
              {step.label}
            </button>
          </Fragment>
        )
      })}
    </nav>
  )
}

// Read-only review of an accepted step's snapshot, entered from the step
// rail. No PTY is spawned; snapshots are the content-addressed files the
// accept action wrote, so what's shown is exactly what was accepted.
function ReviewBody({
  runtimeState,
  family,
}: {
  runtimeState: GuidedBriefRuntimeState
  family: GuidedBriefStage
}) {
  const { workspaceRoot } = runtimeState
  if (family === 'designer-working') {
    const mockups: DesignerMockupFile[] = runtimeState.acceptedMockups.map((mockup) => ({
      name: basename(mockup.path),
      relativePath: mockup.path,
      absolutePath: joinWorkspacePath(workspaceRoot, mockup.path),
    }))
    const uiDirectionAbsolutePath = runtimeState.acceptedUiDirection
      ? joinWorkspacePath(workspaceRoot, runtimeState.acceptedUiDirection.path)
      : joinWorkspacePath(workspaceRoot, 'product/ui-direction.md')
    return (
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1100px)] justify-center px-6 py-6">
        <DesignerReviewPane
          mockups={mockups}
          mockupsDirectoryPath={joinWorkspacePath(workspaceRoot, 'mockups/.versions')}
          uiDirectionPath={uiDirectionAbsolutePath}
          productDirectoryPath={parentPath(uiDirectionAbsolutePath)}
        />
      </div>
    )
  }
  const artifact =
    family === 'strategist-working'
      ? runtimeState.acceptedProductBrief
      : runtimeState.acceptedArchitecturePlan
  if (!artifact) return null
  const absolutePath = joinWorkspacePath(workspaceRoot, artifact.path)
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,860px)] justify-center px-6 py-6">
      <RenderedBriefPane
        briefPath={absolutePath}
        watchDirectoryPath={parentPath(absolutePath)}
        title={`${artifact.title} (accepted)`}
        displayPath={artifact.path}
        unavailableTitle="Accepted snapshot unavailable"
        missingReason={`The accepted snapshot ${artifact.path} is missing on disk.`}
        emptyReason={`The accepted snapshot ${artifact.path} is empty.`}
      />
    </div>
  )
}

// The design-system studio's completion surface (MC-1505 §4, approved T4
// mockup): a card floating over the canvas, replacing the old footer
// version-input row. Rendered only in the ready state — readiness itself
// proved the manifest parses and the bundle lint is clean (useDesignerSession's
// design-system contract), so the idle card's "Lint clean" chip surfaces that
// computation instead of re-running the lint. Phase lifecycle and copy come
// from designSystemRelease.ts; every state is explicit: a lint failure shows
// the report's own rows and routes them to the designer as one message, and a
// pipeline error names itself with a retry — never a silent fallback.
// Disabled reasons stay reachable without hover (a disabled button is
// unfocusable): the reason rides an always-present aria-label on the button,
// and the version format hint is tied to the input via aria-describedby and
// becomes visible text while the version is invalid.
const RELEASE_VERSION_HINT_ID = 'design-system-release-version-hint'

function DesignSystemReleaseCard({
  phase,
  version,
  armed,
  bundleName,
  designerSessionLive,
  onChangeVersion,
  onRelease,
  onAskDesigner,
}: {
  phase: DesignSystemReleasePhase
  version: string
  armed: boolean
  bundleName: string | null
  designerSessionLive: boolean
  onChangeVersion: (value: string) => void
  onRelease: () => void
  onAskDesigner: () => void
}) {
  const inFlight = isReleaseInFlight(phase)
  const versionValid = isValidReleaseVersion(version)
  const destination =
    phase.kind === 'released'
      ? displayLibraryPath(phase.release.path)
      : releaseDestinationDisplay(bundleName, version)
  // Reasons for the version row only — the lint-failed state renders its own
  // action pair (ask-designer primary + disabled save) instead of this row.
  const saveDisabledReason = inFlight ? null : !versionValid ? 'Enter a semver version like 1.0.0.' : null
  const buttonLabel = releaseButtonLabel(phase)

  const versionRow = (
    <div className="mt-3 flex items-center gap-2">
      <input
        value={version}
        onChange={(event) => onChangeVersion(event.target.value)}
        disabled={inFlight}
        aria-label="Release version"
        aria-invalid={!versionValid}
        aria-describedby={RELEASE_VERSION_HINT_ID}
        placeholder="1.0.0"
        spellCheck={false}
        className={`
          h-8 w-24 rounded-md border bg-[color:var(--bg-surface)] px-2.5 text-center font-mono text-[12px] tabular-nums
          text-[color:var(--text-strong)] outline-none transition-colors
          placeholder:text-[color:var(--text-disabled)]
          disabled:cursor-not-allowed disabled:text-[color:var(--text-disabled)]
          focus:border-[color:var(--text-strong)]
          ${versionValid ? 'border-[color:var(--border-default)]' : 'border-[color:var(--tone-error)]'}
        `}
      />
      <PrimaryButton
        onClick={onRelease}
        disabled={!armed}
        aria-label={saveDisabledReason ? `${buttonLabel} — ${saveDisabledReason}` : undefined}
      >
        {buttonLabel}
      </PrimaryButton>
    </div>
  )
  // The format hint doubles as the visible inline error while invalid; it
  // stays in the DOM (sr-only) otherwise so aria-describedby always resolves.
  const versionHint = (
    <span
      id={RELEASE_VERSION_HINT_ID}
      className={versionValid ? 'sr-only' : 'mt-1.5 block text-[11px] text-[color:var(--tone-error)]'}
    >
      Version must be semver, like 1.0.0.
    </span>
  )

  return (
    <section
      aria-label="Save to your design system library"
      className="absolute bottom-5 left-5 z-20 w-[400px] max-w-[calc(100%-2.5rem)] rounded-[14px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] p-4 shadow-[var(--shadow-drawer)]"
    >
      {phase.kind === 'released' ? (
        <>
          <p role="status" className="flex items-center gap-2 text-[12px] font-semibold text-[color:var(--text-strong)]">
            <span aria-hidden="true" className="text-[11px] text-[color:var(--tone-good)]">✓</span>
            Saved{' '}
            <code className="font-mono text-[11px] font-normal">
              {phase.release.name}@{phase.release.version}
            </code>{' '}
            to your library
          </p>
          <button
            type="button"
            onClick={() => void window.api.showItemInFolder(phase.release.path)}
            aria-label={`Show ${phase.release.name}@${phase.release.version} in your file manager`}
            className="mt-2 block max-w-full truncate font-mono text-[11px] text-[color:var(--text-subtle)] underline decoration-[color:var(--border-default)] underline-offset-2 transition-colors hover:text-[color:var(--text-default)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
          >
            {destination}
          </button>
          <p className="mt-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
            This version is immutable. Attach it from Settings → Design systems in any workspace so
            agents build with it — or keep iterating here and save the next version.
          </p>
          {versionRow}
          {versionHint}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[color:var(--text-strong)]">
              Save to your design system library
            </span>
            {phase.kind === 'idle' ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[color:var(--tone-good)]">
                <span aria-hidden="true" className="text-[10px]">✓</span>
                Lint clean · 0 issues
              </span>
            ) : phase.kind === 'validating' ? (
              <span role="status" className="shrink-0 text-[11px] text-[color:var(--text-subtle)]">
                Validating…
              </span>
            ) : phase.kind === 'releasing' ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[color:var(--tone-good)]">
                <span aria-hidden="true" className="text-[10px]">✓</span>
                Lint clean
              </span>
            ) : phase.kind === 'lint-failed' ? (
              <span className="shrink-0 text-[11px] text-[color:var(--tone-error)]">
                {lintIssueCountLabel(parseLintFindings(phase.findings))}
              </span>
            ) : null}
          </div>

          {phase.kind === 'validating' || phase.kind === 'releasing' ? (
            <p role="status" className="mt-2 text-[11px] text-[color:var(--text-muted)]">
              {releaseStatusLine(phase)}
            </p>
          ) : null}
          {phase.kind === 'error' ? (
            <p role="status" className="mt-2 text-[12px] leading-4 text-[color:var(--tone-error)]">
              {phase.message}
            </p>
          ) : null}

          {phase.kind === 'lint-failed' ? (
            <LintFindingsList findings={phase.findings} />
          ) : destination ? (
            <p className="mt-2 truncate font-mono text-[11px] text-[color:var(--text-subtle)]">{destination}</p>
          ) : null}

          {phase.kind === 'lint-failed' ? (
            <div className="mt-3 flex items-center gap-2">
              <PrimaryButton
                onClick={onAskDesigner}
                disabled={!designerSessionLive}
                aria-label={
                  designerSessionLive
                    ? undefined
                    : 'Ask the designer to fix these — the designer session is not connected.'
                }
              >
                Ask the designer to fix these
              </PrimaryButton>
              <SecondaryButton onClick={onRelease} disabled>
                {buttonLabel}
              </SecondaryButton>
            </div>
          ) : (
            <>
              {versionRow}
              {versionHint}
            </>
          )}

          {phase.kind === 'idle' ? (
            <p className="mt-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
              Saved versions are immutable. Attach this system in any workspace so agents build with it.
            </p>
          ) : null}
          {phase.kind === 'lint-failed' ? (
            <p className="mt-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
              Saving is blocked until the bundle passes lint — the issues above go to the designer as
              one message.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

// The lint report rendered as rows (file + the report's own finding text).
// Parsing is presentation-only (parseLintFindings); a report the parser does
// not recognize falls back to the raw text verbatim, never an invented row.
function LintFindingsList({ findings }: { findings: string }) {
  const parsed = parseLintFindings(findings)
  if (parsed.issues.length === 0) {
    return (
      <pre
        tabIndex={0}
        aria-label="Lint report"
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-[color:var(--text-default)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
      >
        {findings}
      </pre>
    )
  }
  return (
    <ul
      tabIndex={0}
      aria-label="Lint findings"
      className="mt-2 max-h-40 overflow-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
    >
      {parsed.issues.map((issue, index) => (
        <li
          key={`${issue.file}:${issue.detail}:${index}`}
          className="flex items-start gap-2 border-b border-[color:var(--border-subtle)] py-1.5 text-[11px] leading-4 text-[color:var(--text-default)] last:border-b-0"
        >
          <span aria-hidden="true" className="mt-px shrink-0 text-[9px] text-[color:var(--tone-error)]">▲</span>
          <span className="min-w-0">
            {issue.detail}{' '}
            <code className="font-mono text-[10px] text-[color:var(--text-subtle)]">{issue.file}</code>
          </span>
        </li>
      ))}
    </ul>
  )
}

function renderPrimaryAction({
  stage,
  accepting,
  startingBuild,
  strategist,
  architect,
  designer,
  onAcceptStrategist,
  onAcceptArchitect,
  onAcceptDesigner,
  onStartBuild,
}: {
  stage: GuidedBriefStage
  accepting: boolean
  startingBuild: boolean
  strategist: ReturnType<typeof useStrategistSession>
  architect: ReturnType<typeof useArchitectSession>
  designer: ReturnType<typeof useDesignerSession>
  onAcceptStrategist: () => void
  onAcceptArchitect: () => void
  onAcceptDesigner: () => void
  onStartBuild: () => void
}) {
  if (stage === 'strategist-ready') {
    const disabled = !strategist.readiness.fileReady || accepting
    return (
      <PrimaryButton onClick={onAcceptStrategist} disabled={disabled}>
        {accepting ? 'Accepting…' : 'Accept brief'}
      </PrimaryButton>
    )
  }
  if (stage === 'architect-ready') {
    const disabled = !architect.readiness.fileReady || accepting
    return (
      <PrimaryButton onClick={onAcceptArchitect} disabled={disabled}>
        {accepting ? 'Accepting…' : 'Accept plan'}
      </PrimaryButton>
    )
  }
  if (stage === 'designer-ready') {
    const disabled = !designer.readiness.mockupsAvailable || !designer.readiness.uiDirectionReady || accepting
    const blockers: string[] = []
    if (!designer.readiness.mockupsAvailable) blockers.push('the screens')
    if (!designer.readiness.uiDirectionReady) blockers.push('the UI direction')
    const button = (
      <PrimaryButton onClick={onAcceptDesigner} disabled={disabled}>
        {accepting ? 'Accepting…' : 'Accept design'}
      </PrimaryButton>
    )
    return disabled && blockers.length > 0 ? (
      <Tooltip content={`Waiting for ${blockers.join(' and ')}.`}>{button}</Tooltip>
    ) : (
      button
    )
  }
  if (stage === 'handoff') {
    return (
      <PrimaryButton onClick={onStartBuild} disabled={startingBuild}>
        {startingBuild ? 'Starting…' : 'Start the build'}
      </PrimaryButton>
    )
  }
  const waitingReason =
    stage === 'designer-working'
      ? 'The designer is still producing the screens and UI direction.'
      : stage === 'architect-working'
        ? 'The architect is still writing the plan.'
      : stage === 'strategist-working'
        ? 'The strategist is still writing the brief.'
        : 'The agent is still working.'
  return (
    <Tooltip content={waitingReason}>
      <button
        type="button"
        disabled
        aria-disabled
        aria-label={waitingReason}
        className="
          inline-flex h-9 cursor-not-allowed items-center rounded-md bg-[color:var(--bg-surface-raised)] px-4
          text-[13px] font-semibold text-[color:var(--text-disabled)]
        "
      >
        Continue
      </button>
    </Tooltip>
  )
}

function DesignerReadinessHint({
  readiness,
  designSystem = false,
}: {
  readiness: ReturnType<typeof useDesignerSession>['readiness']
  designSystem?: boolean
}) {
  if (designSystem) {
    // Design-system studios have no UI-direction artifact; readiness is the
    // validated bundle contract (manifest parses + lint clean + quiet agent).
    // The un-ready copy names the real cause (lint findings, broken manifest)
    // so a lint that never passes reads as "fix the lint", never as an
    // eternal "waiting for files" — see designSystemReadinessHint.
    return (
      <span className="shrink-0 truncate text-[12px] text-[color:var(--text-subtle)]">
        {designSystemReadinessHint(readiness.isReady, readiness.designSystemValidation)}
      </span>
    )
  }
  const waitingFor: string[] = []
  if (!readiness.mockupsAvailable) waitingFor.push('the screens')
  if (!readiness.uiDirectionReady) waitingFor.push('the UI direction')
  if (waitingFor.length === 0) return null
  return (
    <span className="shrink-0 truncate text-[12px] text-[color:var(--text-subtle)]">
      Waiting for {waitingFor.join(' and ')}.
    </span>
  )
}

function SecondaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="
        inline-flex h-9 items-center rounded-md border border-[color:var(--border-default)] px-3 text-[12px] font-medium text-[color:var(--text-default)]
        transition-colors hover:border-[color:var(--accent-primary)] hover:text-[color:var(--text-strong)]
        disabled:cursor-not-allowed disabled:border-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]
        focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
      "
    >
      {children}
    </button>
  )
}

// Tooltip clones its child and injects aria-describedby + hover/focus handlers,
// so PrimaryButton has to forward those props for `<Tooltip><PrimaryButton/></Tooltip>`
// to actually open the tooltip on hover. The base contract (onClick, disabled,
// children) stays unchanged for callers that don't need a tooltip wrapper.
type PrimaryButtonProps = {
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
} & Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'aria-describedby' | 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'onKeyDown'
>

function PrimaryButton({
  onClick,
  disabled,
  children,
  ...rest
}: PrimaryButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className="
        inline-flex h-9 items-center rounded-md bg-[color:var(--accent-primary)] px-4 text-[13px] font-semibold text-[color:var(--bg-app)]
        transition-colors hover:bg-[color:var(--accent-primary-hover)]
        disabled:cursor-not-allowed disabled:bg-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]
        focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
      "
    >
      {children}
    </button>
  )
}

// Strategist stage on the shared studio shell: conversation, the stage's
// expected artifacts with truthful states, and the brief previewed live from
// the moment the file exists — not only at the ready flip.
function StrategistBody({
  stage,
  session,
  starting,
  errorMessage,
  working,
  liveStatus,
  fileReady,
  overviewPath,
  overviewFileReady,
  interview,
  onAnswer,
  transcriptTail,
  requirementsPath,
  productDirectoryPath,
}: {
  stage: GuidedBriefStage
  session: ReturnType<typeof useStrategistSession>['session']
  starting: boolean
  errorMessage: string | null
  working: boolean
  liveStatus: StageLiveStatus
  fileReady: boolean
  overviewPath: string
  overviewFileReady: boolean
  interview: GuidedInterviewState
  onAnswer: (answerText: string) => void
  transcriptTail?: string
  requirementsPath: string
  productDirectoryPath: string
}) {
  const ready = stage === 'strategist-ready'
  return (
    <TextStageStudioBody
      specialistName="Product Strategist"
      specialistSubline={
        ready
          ? 'Brief ready · ask anything else if needed'
          : 'Asking about the idea — pick an option or answer in the terminal'
      }
      session={session}
      starting={starting}
      errorMessage={errorMessage}
      working={working}
      liveStatus={liveStatus}
      interview={interview}
      onAnswer={onAnswer}
      transcriptTail={transcriptTail}
      ready={ready}
      plan={{
        name: 'requirements.md',
        relativePath: 'product/requirements.md',
        absolutePath: requirementsPath,
        fileReady,
        title: 'Brief',
        unavailableTitle: 'Brief not started',
        missingReason:
          "The strategist hasn't written the brief yet. It appears here as soon as the file exists.",
        emptyReason: 'The brief file exists but has no content yet.',
      }}
      overview={{
        name: 'overview.html',
        relativePath: 'product/overview.html',
        absolutePath: overviewPath,
        fileReady: overviewFileReady,
      }}
      watchDirectoryPath={productDirectoryPath}
    />
  )
}

function ArchitectBody({
  stage,
  session,
  starting,
  errorMessage,
  working,
  liveStatus,
  fileReady,
  overviewPath,
  overviewFileReady,
  interview,
  onAnswer,
  transcriptTail,
  architecturePlanPath,
  architectureDirectoryPath,
}: {
  stage: GuidedBriefStage
  session: ReturnType<typeof useArchitectSession>['session']
  starting: boolean
  errorMessage: string | null
  working: boolean
  liveStatus: StageLiveStatus
  fileReady: boolean
  overviewPath: string
  overviewFileReady: boolean
  interview: GuidedInterviewState
  onAnswer: (answerText: string) => void
  transcriptTail?: string
  architecturePlanPath: string
  architectureDirectoryPath: string
}) {
  const ready = stage === 'architect-ready'
  return (
    <TextStageStudioBody
      specialistName="Architect"
      specialistSubline={
        ready
          ? 'Plan ready · ask anything else if needed'
          : 'Resolving architecture decisions — pick an option or answer in the terminal'
      }
      session={session}
      starting={starting}
      errorMessage={errorMessage}
      working={working}
      liveStatus={liveStatus}
      interview={interview}
      onAnswer={onAnswer}
      transcriptTail={transcriptTail}
      ready={ready}
      plan={{
        name: 'plan.md',
        relativePath: 'architecture/plan.md',
        absolutePath: architecturePlanPath,
        fileReady,
        title: 'Plan',
        unavailableTitle: 'Plan not started',
        missingReason:
          "The architect hasn't written the plan yet. It appears here as soon as the file exists.",
        emptyReason: 'The plan file exists but has no content yet.',
      }}
      overview={{
        name: 'overview.html',
        relativePath: 'architecture/overview.html',
        absolutePath: overviewPath,
        fileReady: overviewFileReady,
      }}
      watchDirectoryPath={architectureDirectoryPath}
    />
  )
}

// Shared strategist/architect studio composition: one markdown plan (the
// canonical artifact) plus an optional agent-produced HTML overview. The
// artifacts pane selects which one the preview shows; the overview becomes
// the default once the stage is ready and the file exists.
function TextStageStudioBody({
  specialistName,
  specialistSubline,
  session,
  starting,
  errorMessage,
  working,
  liveStatus,
  interview,
  onAnswer,
  transcriptTail,
  ready,
  plan,
  overview,
  watchDirectoryPath,
}: {
  specialistName: string
  specialistSubline: string
  session: GuidedBriefSpecialistSession | null
  starting: boolean
  errorMessage: string | null
  working: boolean
  liveStatus: StageLiveStatus
  interview: GuidedInterviewState
  onAnswer: (answerText: string) => void
  transcriptTail?: string
  ready: boolean
  plan: {
    name: string
    relativePath: string
    absolutePath: string
    fileReady: boolean
    title: string
    unavailableTitle: string
    missingReason: string
    emptyReason: string
  }
  overview: {
    name: string
    relativePath: string
    absolutePath: string
    fileReady: boolean
  }
  watchDirectoryPath: string
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const effectiveSelected =
    selectedPath ?? (ready && overview.fileReady ? overview.relativePath : plan.relativePath)

  // The stage's small fixed document set on the canvas: the canonical markdown
  // (brief / plan) and the agent-produced HTML preview. The pill toggles which
  // one the canvas renders; a not-yet-written document shows its own unavailable
  // state, never a blank tab.
  const nav: CanvasStudioNav = {
    kind: 'documents',
    documents: [
      { id: plan.relativePath, label: plan.title },
      { id: overview.relativePath, label: 'Preview' },
    ],
    activeId: effectiveSelected,
    onSelect: setSelectedPath,
  }

  return (
    <CanvasStudio
      nav={nav}
      agent={{
        name: specialistName,
        liveStatus,
        ready,
        renderConversation: ({ onCollapse }) => (
          <ConversationPane
            session={session}
            starting={starting}
            errorMessage={errorMessage}
            specialistName={specialistName}
            specialistSubline={specialistSubline}
            working={working}
            liveStatus={liveStatus}
            ready={ready}
            interview={interview}
            onAnswer={onAnswer}
            transcriptTail={transcriptTail}
            onCollapse={onCollapse}
          />
        ),
      }}
    >
      {effectiveSelected === overview.relativePath ? (
        <HtmlArtifactFrame
          absolutePath={overview.absolutePath}
          relativePath={overview.relativePath}
          watchDirectoryPath={watchDirectoryPath}
        />
      ) : (
        <RenderedBriefPane
          briefPath={plan.absolutePath}
          watchDirectoryPath={watchDirectoryPath}
          title={plan.title}
          displayPath={plan.relativePath}
          unavailableTitle={plan.unavailableTitle}
          missingReason={plan.missingReason}
          emptyReason={plan.emptyReason}
        />
      )}
    </CanvasStudio>
  )
}

// Resolve each real HTML page's <title> for the screen switcher (MC-1505),
// keyed by path+mtime so a page is read once and re-read only when it changes —
// the same one-shot cache pattern the component gallery uses. Reads reuse the
// existing readfile IPC (no new watcher); the pages already re-collect on
// useDesignerSession's watch/poll. Returns relativePath → resolved title, with
// entries omitted when the page has no (or empty) <title>.
function useScreenTitles(index: DesignArtifactIndex): Map<string, string> {
  const requests = useMemo(() => {
    const pages = index.groups.find((group) => group.id === 'pages')
    if (!pages) return [] as Array<{ key: string; relativePath: string; absolutePath: string }>
    return pages.entries.map((entry) => ({
      key: `${entry.relativePath}::${entry.modifiedAtMs ?? 0}`,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
    }))
  }, [index])
  // key → resolved <title> ('' when the page has none); a present key means read.
  const [titlesByKey, setTitlesByKey] = useState<Map<string, string>>(new Map())
  const requestKey = requests.map((request) => request.key).join('|')

  useEffect(() => {
    let cancelled = false
    const missing = requests.filter((request) => !titlesByKey.has(request.key))
    if (missing.length === 0) return
    void Promise.all(
      missing.map(async (request): Promise<readonly [string, string]> => {
        try {
          return [request.key, pageTitleFromHtml(await window.api.readfile(request.absolutePath)) ?? ''] as const
        } catch {
          return [request.key, ''] as const
        }
      }),
    ).then((pairs) => {
      if (cancelled) return
      setTitlesByKey((previous) => {
        const next = new Map(previous)
        for (const [key, value] of pairs) next.set(key, value)
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // requestKey captures the current key set; titlesByKey re-runs the guard after a set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, titlesByKey])

  return useMemo(() => {
    const byPath = new Map<string, string>()
    for (const request of requests) {
      const title = titlesByKey.get(request.key)
      if (title) byPath.set(request.relativePath, title)
    }
    return byPath
  }, [requests, titlesByKey])
}

// Designer studio (both presets): the selected artifact fills the canvas, the
// screens switcher / gallery placeholder rides the floating pill, and the
// designer lives in the floating agent bubble (CanvasStudio shell, MC-1510).
function DesignStudioBody({
  session,
  starting,
  errorMessage,
  working,
  liveStatus,
  ready,
  interview,
  onAnswer,
  transcriptTail,
  mockupCount,
  designSystem = false,
  designArtifacts,
  activeDesignArtifactPath,
  onSelectDesignArtifact,
  releaseCard = null,
}: {
  session: ReturnType<typeof useDesignerSession>['session']
  starting: boolean
  errorMessage: string | null
  working: boolean
  liveStatus: StageLiveStatus
  ready: boolean
  interview: GuidedInterviewState
  onAnswer: (answerText: string) => void
  transcriptTail?: string
  mockupCount: number
  designSystem?: boolean
  designArtifacts: DesignArtifactIndex
  activeDesignArtifactPath: string | null
  onSelectDesignArtifact: (entry: DesignArtifactEntry) => void
  /** Design-system completion surface, floated over the canvas (MC-1505 §4).
   * Sits between the canvas content and the agent bubble in tab order. */
  releaseCard?: React.ReactNode
}) {
  const selectedEntry = findDesignArtifact(designArtifacts, activeDesignArtifactPath)
  // The design-system preset opens in the live component gallery (MC-1509);
  // selecting any card or bundle file switches to the single-file (File) view.
  // frontend-design has no gallery — its canvas is always the selected screen.
  const [designSystemView, setDesignSystemView] = useState<DesignSystemViewMode>('gallery')

  // Annotate sink (MC-1468 T11, Sink B): a pin batch submitted from the HTML
  // preview becomes ONE composed chat message to the designer session, sent
  // over the session's own transport (the same split lintFixRequestMessage
  // uses). Offered only while the session is live — with no designer there is
  // nowhere for the notes to go, so the frame's Comment mode stays off. A
  // rejected send keeps the batch in the frame's tray for retry.
  const submitAnnotationsToDesigner =
    session && selectedEntry
      ? async (annotations: MockupAnnotation[]) => {
          const message = designerAnnotationMessage(
            selectedEntry.relativePath,
            annotations,
            session.transport,
          )
          if (session.transport === 'conversation') {
            const result = await window.api.conversationSessionSendTurn({
              sessionId: session.sessionId,
              message,
            })
            if (!result.ok) throw new Error(result.message)
          } else {
            window.api.terminalWriteFast(session.sessionId, `${message}\r`)
          }
        }
      : undefined
  // Canvas-first means a design fills the surface as soon as one exists: when
  // nothing is selected yet, default to the first indexed artifact (pages sort
  // first, so frontend-design lands on a screen) instead of an empty canvas.
  // The design-system preset opens in Gallery regardless, so this only primes
  // the File view's selection.
  useEffect(() => {
    if (activeDesignArtifactPath) return
    const first = designArtifacts.entries[0]
    if (first) onSelectDesignArtifact(first)
  }, [activeDesignArtifactPath, designArtifacts, onSelectDesignArtifact])

  const openBundleFile = (relativePath: string) => {
    const entry = findDesignArtifact(designArtifacts, relativePath)
    if (!entry) return
    onSelectDesignArtifact(entry)
    setDesignSystemView('file')
  }
  // Honest bundle count (MC-1502): only files under design-system/ are "in the
  // bundle" — inspiration files are listed in their group but never counted.
  const bundleFileCount = designSystemBundleFileCount(designArtifacts)

  const specialistName = designSystem ? 'Design System Designer' : 'Frontend Designer'
  const specialistSubline = designSystem
    ? bundleFileCount > 0
      ? `${bundleFileCount} file${bundleFileCount === 1 ? '' : 's'} in the bundle · ask for changes anytime`
      : 'Describe the system you want — tokens, components, and patterns land as real files'
    : mockupCount > 0
      ? `${mockupCount} screen${mockupCount === 1 ? '' : 's'} in this run · ask for changes anytime`
      : 'Describe the screens you want — files and preview update as they’re written'

  // Screen switcher labels are page titles, not raw filenames (MC-1505): read
  // each real HTML page's <title>, then upgrade the switcher's display name
  // from the filename fallback to the resolved title.
  const screenTitles = useScreenTitles(designArtifacts)
  const screens = canvasScreensFromIndex(designArtifacts).map((screen) => ({
    ...screen,
    name: screenTitles.get(screen.id) ?? humanizeFileTitle(screen.path),
  }))

  // frontend-design navigates its real HTML pages inline (≤6) or via the
  // screens drawer (7+). design-system swaps the switcher for the Gallery/File
  // toggle (MC-1509): Gallery is the live component grid, File the single-file
  // preview of the selected bundle file.
  const nav: CanvasStudioNav = designSystem
    ? { kind: 'gallery', mode: designSystemView, onSelectMode: setDesignSystemView }
    : {
        kind: 'screens',
        screens,
        activeId: activeDesignArtifactPath,
        onSelect: (id) => {
          const entry = findDesignArtifact(designArtifacts, id)
          if (entry) onSelectDesignArtifact(entry)
        },
      }

  return (
    <CanvasStudio
      nav={nav}
      agent={{
        name: specialistName,
        liveStatus,
        ready,
        renderConversation: ({ onCollapse }) => (
          <ConversationPane
            session={session}
            starting={starting}
            errorMessage={errorMessage}
            specialistName={specialistName}
            specialistSubline={specialistSubline}
            working={working}
            liveStatus={liveStatus}
            ready={ready}
            interview={interview}
            onAnswer={onAnswer}
            transcriptTail={transcriptTail}
            onCollapse={onCollapse}
          />
        ),
      }}
    >
      {designSystem && designSystemView === 'gallery' ? (
        <ComponentGalleryPane designArtifacts={designArtifacts} onOpenFile={openBundleFile} />
      ) : (
        <DesignArtifactPreviewPane
          entry={selectedEntry}
          onSubmitAnnotations={submitAnnotationsToDesigner}
          annotateSubmitLabel="Send to designer"
        />
      )}
      {releaseCard}
    </CanvasStudio>
  )
}

type DesignerReviewTab = 'mockup' | 'direction'

function DesignerReviewPane({
  mockups,
  mockupsDirectoryPath,
  uiDirectionPath,
  productDirectoryPath,
}: {
  mockups: DesignerMockupFile[]
  mockupsDirectoryPath: string
  uiDirectionPath: string
  productDirectoryPath: string
}) {
  const [activeTab, setActiveTab] = useState<DesignerReviewTab>('mockup')
  const tabs: TabItem<DesignerReviewTab>[] = [
    { id: 'mockup', label: 'Mockup', count: mockups.length },
    { id: 'direction', label: 'UI direction' },
  ]

  return (
    <section
      aria-label="Designer review artifacts"
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <Tabs<DesignerReviewTab>
        ariaLabel="Designer review artifacts"
        items={tabs}
        value={activeTab}
        onChange={setActiveTab}
      />
      <div className="min-h-0 flex-1">
        {activeTab === 'mockup' ? (
          <MockupPreviewPane mockups={mockups} watchDirectoryPath={mockupsDirectoryPath} />
        ) : (
          <RenderedBriefPane
            briefPath={uiDirectionPath}
            watchDirectoryPath={productDirectoryPath}
            title="UI direction"
            unavailableTitle="UI direction not available"
            missingReason="product/ui-direction.md has not been written yet."
            emptyReason="product/ui-direction.md is empty."
          />
        )}
      </div>
    </section>
  )
}

function HandoffBody({
  runtimeState,
  onChange,
  cliOptions,
  sprintEngineRoleRegistry,
  sprintEngineDisabledRoleIds,
}: {
  runtimeState: GuidedBriefRuntimeState
  onChange: (next: GuidedBriefRuntimeState) => void
  cliOptions: Array<{ value: AgentCli; label: string }>
  sprintEngineRoleRegistry: SprintEngineRoleRegistry | null
  sprintEngineDisabledRoleIds: ReadonlySet<SprintEngineRoleId> | null
}) {
  const [handoffStatus, setHandoffStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const handoffPath = joinWorkspacePath(runtimeState.workspaceRoot, guidedBriefBuildHandoffRelativePath())
  const checklist = guidedBriefHandoffChecklist(runtimeState)
  // Mask the displayed counts and roster total so a role the user disabled
  // after this guided brief was scaffolded doesn't appear to add specialists
  // that the create boundary will silently drop.
  const visibleRoleCounts = sprintEngineDisabledRoleIds && sprintEngineDisabledRoleIds.size > 0
    ? applyUserDisabledSprintEngineRoleCounts(runtimeState.buildRoleCounts, sprintEngineDisabledRoleIds)
    : runtimeState.buildRoleCounts
  const totalAgents = Object.values(visibleRoleCounts).reduce(
    (total, count) => total + Math.max(0, count),
    0,
  )
  const automationMode: SprintEngineAutomationMode = runtimeState.buildAutoApproveArtifacts
    ? 'run_agents_and_approve_artifacts'
    : runtimeState.buildStartRunner
      ? 'run_agents'
      : 'manual'

  const setBuildRoleCount = (role: SprintEngineRoleId, count: number) => {
    const min = role === 'architect' ? 1 : 0
    onChange({
      ...runtimeState,
      buildRoleCliDefaults: {
        ...runtimeState.buildRoleCliDefaults,
        [role]: runtimeState.buildRoleCliDefaults[role] ?? 'claude-code',
      },
      buildRoleCounts: {
        ...runtimeState.buildRoleCounts,
        [role]: Math.max(min, Math.min(10, Math.floor(count))),
      },
    })
  }

  const setBuildRoleCli = (role: SprintEngineRoleId, cli: AgentCli) => {
    onChange({
      ...runtimeState,
      buildRoleCliDefaults: {
        ...runtimeState.buildRoleCliDefaults,
        [role]: cli,
      },
    })
  }

  const setAutomationMode = (mode: SprintEngineAutomationMode) => {
    onChange({
      ...runtimeState,
      buildStartRunner: mode !== 'manual',
      buildAutoApproveArtifacts: mode === 'run_agents_and_approve_artifacts',
    })
  }

  useEffect(() => {
    let cancelled = false
    void window.api.readfile(handoffPath)
      .then(() => {
        if (!cancelled) setHandoffStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setHandoffStatus('missing')
      })
    return () => {
      cancelled = true
    }
  }, [handoffPath])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-7 px-8 pt-10 pb-14">
        <header className="flex flex-col gap-1.5">
          <h3 className="text-[22px] font-semibold leading-7 tracking-tight text-[color:var(--text-strong)]">
            Ready to build
          </h3>
          <p className="text-[13px] leading-5 text-[color:var(--text-muted)]">
            The generated handoff becomes the plan source for the new sprint roster.
          </p>
        </header>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-medium text-[color:var(--text-default)]">Build handoff</span>
            <div className="flex flex-col gap-2">
              {checklist.map((item) => (
                <div
                  key={`${item.label}:${item.path}`}
                  className="flex min-w-0 items-start justify-between gap-3 rounded-md border border-[color:var(--border-default)] px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-[12px] font-medium text-[color:var(--text-default)]">{item.label}</span>
                    <TruncatedText as="span" text={item.path} className="font-mono text-[11px] text-[color:var(--text-muted)]" />
                  </div>
                  {item.hash ? (
                    <span className="shrink-0 font-mono text-[11px] text-[color:var(--text-subtle)]">
                      {item.hash.slice(0, 10)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <RosterAndRunSettings
            roleCounts={visibleRoleCounts}
            roleCliDefaults={runtimeState.buildRoleCliDefaults}
            cliOptions={cliOptions}
            registry={sprintEngineRoleRegistry}
            disabledRoleIds={sprintEngineDisabledRoleIds}
            countDisabled={false}
            cliDisabled={false}
            onSetCount={setBuildRoleCount}
            onSetCli={setBuildRoleCli}
            totalAgents={totalAgents}
            automationMode={automationMode}
            onChangeAutomationMode={setAutomationMode}
            cliPermissionPreset={runtimeState.buildCliPermissionPreset}
            onChangeCliPermissionPreset={(preset) => onChange({ ...runtimeState, buildCliPermissionPreset: preset })}
          />

          {handoffStatus === 'missing' ? (
            <span className="text-[12px] text-[color:var(--tone-error)]">
              Could not read {guidedBriefBuildHandoffRelativePath()}.
            </span>
          ) : (
            <span className="text-[12px] text-[color:var(--text-subtle)]">
              {handoffStatus === 'loading' ? 'Reading build handoff…' : 'Build handoff is ready.'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
