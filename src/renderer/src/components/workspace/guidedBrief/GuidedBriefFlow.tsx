import { useEffect, useState } from 'react'
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
  snapshotGuidedBriefArtifact,
  GuidedBriefWorkspaceError,
  writeGuidedBriefBuildHandoff,
} from '../../../utils/guidedBriefWorkspace'
import { applyUserDisabledSprintEngineRoleCounts } from '../../../utils/sprintengine'
import { sprintEngineAutomationModeOptions } from '../../../utils/sprintengineAutomation'
import { CloseIconButton, StatusDot, Tabs, Tooltip, WizardProgress, type TabItem } from '../../ui'
import { SprintEngineRosterTable } from '../newWorkspace/SprintEngineRosterTable'
import { CliPermissionPresetRow, PathRadio } from '../newWorkspace/WizardControls'
import { ConversationPane } from './ConversationPane'
import { MockupPreviewPane } from './MockupPreviewPane'
import { RenderedBriefPane } from './RenderedBriefPane'
import { useArchitectSession } from './useArchitectSession'
import { useDesignerSession, type DesignerMockupFile } from './useDesignerSession'
import { useStrategistSession } from './useStrategistSession'
import { joinWorkspacePath } from './paths'
import {
  guidedBriefBuildHandoffRelativePath,
  guidedBriefHandoffChecklist,
  guidedBriefPlanningDecisionNotes,
  guidedBriefPlanningValidationNotes,
} from './handoff'
import {
  guidedBriefSkipToHandoffState,
  progressForStage,
  stepCounterLabel,
  type GuidedBriefAcceptedArtifact,
  type GuidedBriefRuntimeState,
  type GuidedBriefStage,
} from './types'

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
  onBackToIdea: () => void
  onClose?: () => void
  onStartBuild: (
    runtimeState: GuidedBriefRuntimeState,
    runOptions: GuidedBriefRunOptions,
  ) => Promise<void>
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  sprintEngineRoleRegistry?: SprintEngineRoleRegistry | null
  sprintEngineDisabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
}

export function GuidedBriefFlow({
  runtimeState,
  onChange,
  onBackToIdea,
  onClose,
  onStartBuild,
  cliRuntimes,
  sprintEngineRoleRegistry = null,
  sprintEngineDisabledRoleIds = null,
}: Props) {
  const { stage, hasUi, workspaceRoot, workspaceName, acceptedProductBrief, acceptedArchitecturePlan } = runtimeState
  const progressOptions = {
    wantsProductDiscussion: runtimeState.wantsProductDiscussion,
    wantsArchitectureDiscussion: runtimeState.wantsArchitectureDiscussion,
    wantsFrontendDiscussion: runtimeState.wantsFrontendDiscussion,
  }
  const progress = progressForStage(stage, hasUi, progressOptions)
  const counter = stepCounterLabel(stage, hasUi, progressOptions)
  const inStrategistStage = stage === 'strategist-working' || stage === 'strategist-ready'
  const inArchitectStage = stage === 'architect-working' || stage === 'architect-ready'
  const inDesignerStage = stage === 'designer-working' || stage === 'designer-ready'

  const strategist = useStrategistSession({
    workspaceRoot,
    cli: runtimeState.guidedRoleCliDefaults.product,
    cliRuntimes,
    enabled: inStrategistStage,
    sessionId: runtimeState.strategistSessionId,
    onAssignSessionId: (id) => {
      if (runtimeState.strategistSessionId === id) return
      onChange({ ...runtimeState, strategistSessionId: id })
    },
  })

  const acceptedBriefRelativePath = acceptedProductBrief?.path ?? null
  const architect = useArchitectSession({
    workspaceRoot,
    acceptedBriefSnapshotPath: acceptedBriefRelativePath,
    cli: runtimeState.guidedRoleCliDefaults.architect,
    cliRuntimes,
    enabled: inArchitectStage,
    sessionId: runtimeState.architectSessionId,
    onAssignSessionId: (id) => {
      if (runtimeState.architectSessionId === id) return
      onChange({ ...runtimeState, architectSessionId: id })
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
    cliRuntimes,
    enabled:
      hasUi === 'yes' &&
      runtimeState.wantsFrontendDiscussion &&
      inDesignerStage,
    sessionId: runtimeState.designerSessionId,
    onAssignSessionId: (id) => {
      if (runtimeState.designerSessionId === id) return
      onChange({ ...runtimeState, designerSessionId: id })
    },
  })

  // Strategist working → ready as soon as a real signal arrives.
  useEffect(() => {
    if (stage === 'strategist-working' && strategist.readiness.isReady) {
      onChange({ ...runtimeState, stage: 'strategist-ready' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, strategist.readiness.isReady])

  useEffect(() => {
    if (stage === 'architect-working' && architect.readiness.isReady) {
      onChange({ ...runtimeState, stage: 'architect-ready' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, architect.readiness.isReady])

  // Designer working → ready as soon as real mockup files exist (or marker +
  // files). Real file presence is the contractual gate; marker alone is a hint.
  useEffect(() => {
    if (stage === 'designer-working' && designer.readiness.isReady) {
      onChange({ ...runtimeState, stage: 'designer-ready' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, designer.readiness.isReady])

  // Track the active mockup in runtime state once mockups appear, so the
  // preview pane has a stable selection across re-renders.
  useEffect(() => {
    if (!designer.mockups.length) return
    if (
      runtimeState.activeMockupPath &&
      designer.mockups.some((m) => m.relativePath === runtimeState.activeMockupPath)
    ) {
      return
    }
    onChange({ ...runtimeState, activeMockupPath: designer.mockups[0].relativePath })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designer.mockups])

  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [startingBuild, setStartingBuild] = useState(false)
  const [startBuildError, setStartBuildError] = useState<string | null>(null)
  const [skippingPlanning, setSkippingPlanning] = useState(false)
  const [skipError, setSkipError] = useState<string | null>(null)
  const automationMode: SprintEngineAutomationMode = runtimeState.buildAutoApproveArtifacts
    ? 'run_agents_and_approve_artifacts'
    : runtimeState.buildStartRunner
      ? 'run_agents'
      : 'manual'
  const effectiveAutoApprove = automationMode === 'run_agents_and_approve_artifacts'

  const acceptStrategistBrief = async () => {
    if (!strategist.readiness.fileReady) return
    setAccepting(true)
    setAcceptError(null)
    try {
      const snapshot = await snapshotGuidedBriefArtifact({
        workspaceRoot,
        sourcePath: strategist.requirementsPath,
        kind: 'product',
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
      const nextStage = nextGuidedBriefStage({ ...runtimeState, acceptedProductBrief: accepted }, 'strategist')
      // The strategist's job is done — kill the PTY and clear the persisted id
      // so it does not reattach on the next render.
      const strategistSessionIdToKill = runtimeState.strategistSessionId
      const nextState = {
        ...runtimeState,
        stage: nextStage,
        acceptedProductBrief: accepted,
        strategistSessionId: null,
      }
      if (nextStage === 'handoff') {
        await writeGuidedBriefBuildHandoff({
          workspaceRoot,
          idea: runtimeState.idea,
          hasUi,
          productBrief: accepted,
          architecturePlan: runtimeState.acceptedArchitecturePlan,
          requireMockups: false,
          confirmedDecisions: [
            hasUi === 'yes'
              ? 'Application includes a visual UI, but no frontend design stage was requested.'
              : 'No visual UI is required.',
          ],
          filesystem: {
            ensureDir: window.api.ensureDir,
            readFile: window.api.readfile,
            writeFile: window.api.writefile,
          },
        })
      }
      onChange(nextState)
      if (strategistSessionIdToKill) {
        void window.api.terminalKill(strategistSessionIdToKill).catch(() => {})
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
      const nextStage = nextGuidedBriefStage({ ...runtimeState, acceptedArchitecturePlan: accepted }, 'architect')
      const architectSessionIdToKill = runtimeState.architectSessionId
      const nextState = {
        ...runtimeState,
        stage: nextStage,
        acceptedArchitecturePlan: accepted,
        architectSessionId: null,
      }
      if (nextStage === 'handoff') {
        await writeGuidedBriefBuildHandoff({
          workspaceRoot,
          idea: runtimeState.idea,
          hasUi,
          productBrief: runtimeState.acceptedProductBrief,
          architecturePlan: accepted,
          requireMockups: false,
          confirmedDecisions: [
            hasUi === 'yes' ? 'Application includes a visual UI.' : 'No visual UI is required.',
          ],
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
        void window.api.terminalKill(architectSessionIdToKill).catch(() => {})
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
        requireMockups: true,
        confirmedDecisions: ['Application includes a visual UI.'],
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
        void window.api.terminalKill(designerSessionIdToKill).catch(() => {})
      }
    } catch (error) {
      setAcceptError(formatAcceptError(error, 'mockup'))
    } finally {
      setAccepting(false)
    }
  }

  const primaryAction = renderPrimaryAction({
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
        requireMockups: false,
        confirmedDecisions: guidedBriefPlanningDecisionNotes(nextState),
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
        void window.api.terminalKill(sessionId).catch(() => {})
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
            · Guided brief{hasUi === 'no' ? ' · no UI' : ''}
          </span>
        </div>
        <WizardProgress total={progress.total} active={progress.active} done={progress.done} />
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
        {inStrategistStage ? (
          <StrategistBody
            stage={stage}
            session={strategist.session}
            starting={strategist.status === 'starting' || strategist.status === 'idle'}
            errorMessage={strategist.error}
            isLive={strategist.status === 'running' || strategist.status === 'ready'}
            requirementsPath={strategist.requirementsPath}
            productDirectoryPath={joinWorkspacePath(workspaceRoot, 'product')}
          />
        ) : inArchitectStage ? (
          <ArchitectBody
            stage={stage}
            session={architect.session}
            starting={architect.status === 'starting' || architect.status === 'idle'}
            errorMessage={architect.error}
            isLive={architect.status === 'running' || architect.status === 'ready'}
            architecturePlanPath={architect.architecturePlanPath}
            architectureDirectoryPath={joinWorkspacePath(workspaceRoot, 'architecture')}
          />
        ) : inDesignerStage ? (
          <DesignerBody
            stage={stage}
            session={designer.session}
            starting={designer.status === 'starting' || designer.status === 'idle'}
            errorMessage={designer.error}
            isLive={designer.status === 'running' || designer.status === 'ready'}
            mockups={designer.mockups}
            uiDirectionPath={designer.uiDirectionPath}
            productDirectoryPath={joinWorkspacePath(workspaceRoot, 'product')}
            mockupsDirectoryPath={designer.mockupsDirectoryPath}
          />
        ) : (
          <HandoffBody
            runtimeState={runtimeState}
            onChange={onChange}
            sprintEngineRoleRegistry={sprintEngineRoleRegistry}
            sprintEngineDisabledRoleIds={sprintEngineDisabledRoleIds}
          />
        )}
      </main>

      <footer className="flex shrink-0 items-center gap-3 border-t border-[color:var(--bg-surface-raised)] px-5 py-3">
        <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--text-subtle)]">
          {counter}
        </span>
        {stage === 'designer-working' || stage === 'designer-ready' ? (
          <DesignerReadinessHint readiness={designer.readiness} />
        ) : null}
        {acceptError ? (
          <span className="truncate text-[12px] text-[color:var(--tone-error)]">{acceptError}</span>
        ) : null}
        {startBuildError ? (
          <span className="truncate text-[12px] text-[color:var(--tone-error)]">{startBuildError}</span>
        ) : null}
        {skipError ? (
          <span className="truncate text-[12px] text-[color:var(--tone-error)]">{skipError}</span>
        ) : null}
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
        {stage !== 'handoff' ? (
          <SecondaryButton onClick={() => void skipToRoster()} disabled={skippingPlanning}>
            {skippingPlanning ? 'Skipping…' : 'Skip to roster'}
          </SecondaryButton>
        ) : null}
        {primaryAction}
      </footer>
    </section>
  )
}

function formatAcceptError(error: unknown, kind: 'brief' | 'plan' | 'mockup'): string {
  if (error instanceof GuidedBriefWorkspaceError) return `Could not snapshot the ${kind} (${error.code}).`
  if (error instanceof Error) return error.message
  return `Could not snapshot the ${kind}.`
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
        {accepting ? 'Accepting…' : 'Accept · continue'}
      </PrimaryButton>
    )
  }
  if (stage === 'architect-ready') {
    const disabled = !architect.readiness.fileReady || accepting
    return (
      <PrimaryButton onClick={onAcceptArchitect} disabled={disabled}>
        {accepting ? 'Accepting…' : 'Accept · continue'}
      </PrimaryButton>
    )
  }
  if (stage === 'designer-ready') {
    const disabled = !designer.readiness.mockupsAvailable || !designer.readiness.uiDirectionReady || accepting
    const blockers: string[] = []
    if (!designer.readiness.mockupsAvailable) blockers.push('mockups/*.html')
    if (!designer.readiness.uiDirectionReady) blockers.push('product/ui-direction.md')
    const button = (
      <PrimaryButton onClick={onAcceptDesigner} disabled={disabled}>
        {accepting ? 'Accepting…' : 'Accept · continue'}
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
      ? 'Waiting for mockups/app.html and product/ui-direction.md, or the MOCKUP_SET_READY marker.'
      : stage === 'architect-working'
        ? 'Waiting for architecture/plan.md, or the ARCHITECTURE_PLAN_READY marker.'
      : stage === 'strategist-working'
        ? 'Waiting for product/requirements.md, or the BRIEF_READY marker.'
        : 'Waiting for the agent to finish.'
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
}: {
  readiness: ReturnType<typeof useDesignerSession>['readiness']
}) {
  const items: Array<{ label: string; ready: boolean }> = [
    { label: 'marker', ready: readiness.markerReceived },
    { label: 'mockup', ready: readiness.mockupsAvailable },
    { label: 'ui direction', ready: readiness.uiDirectionReady },
  ]
  return (
    <span
      aria-label="Designer readiness"
      className="inline-flex shrink-0 items-center gap-2 font-mono text-[11px] text-[color:var(--text-subtle)]"
    >
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          <StatusDot tone={item.ready ? 'good' : 'neutral'} />
          <span>{item.label}</span>
        </span>
      ))}
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
  'aria-describedby' | 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'onKeyDown'
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

function StrategistBody({
  stage,
  session,
  starting,
  errorMessage,
  isLive,
  requirementsPath,
  productDirectoryPath,
}: {
  stage: GuidedBriefStage
  session: ReturnType<typeof useStrategistSession>['session']
  starting: boolean
  errorMessage: string | null
  isLive: boolean
  requirementsPath: string
  productDirectoryPath: string
}) {
  const ready = stage === 'strategist-ready'

  return (
    <div
      className={`grid h-full min-h-0 gap-5 px-6 py-6 motion-safe:transition-[grid-template-columns] motion-safe:duration-[220ms] motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
        ready ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,720px)] justify-center'
      }`}
    >
      <ConversationPane
        session={session}
        starting={starting}
        errorMessage={errorMessage}
        specialistName="Product Strategist"
        specialistSubline={
          ready
            ? 'Brief ready · ask anything else if needed'
            : 'Asking about the idea — answer in the terminal'
        }
        isLive={isLive}
      />
      {ready ? (
        <RenderedBriefPane briefPath={requirementsPath} watchDirectoryPath={productDirectoryPath} />
      ) : null}
    </div>
  )
}

function ArchitectBody({
  stage,
  session,
  starting,
  errorMessage,
  isLive,
  architecturePlanPath,
  architectureDirectoryPath,
}: {
  stage: GuidedBriefStage
  session: ReturnType<typeof useArchitectSession>['session']
  starting: boolean
  errorMessage: string | null
  isLive: boolean
  architecturePlanPath: string
  architectureDirectoryPath: string
}) {
  const ready = stage === 'architect-ready'

  return (
    <div
      className={`grid h-full min-h-0 gap-5 px-6 py-6 motion-safe:transition-[grid-template-columns] motion-safe:duration-[220ms] motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
        ready ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,720px)] justify-center'
      }`}
    >
      <ConversationPane
        session={session}
        starting={starting}
        errorMessage={errorMessage}
        specialistName="Architect"
        specialistSubline={
          ready
            ? 'Plan ready · ask anything else if needed'
            : 'Resolving architecture decisions — answer in the terminal'
        }
        isLive={isLive}
      />
      {ready ? (
        <RenderedBriefPane briefPath={architecturePlanPath} watchDirectoryPath={architectureDirectoryPath} />
      ) : null}
    </div>
  )
}

function DesignerBody({
  stage,
  session,
  starting,
  errorMessage,
  isLive,
  mockups,
  uiDirectionPath,
  productDirectoryPath,
  mockupsDirectoryPath,
}: {
  stage: GuidedBriefStage
  session: ReturnType<typeof useDesignerSession>['session']
  starting: boolean
  errorMessage: string | null
  isLive: boolean
  mockups: DesignerMockupFile[]
  uiDirectionPath: string
  productDirectoryPath: string
  mockupsDirectoryPath: string
}) {
  const ready = stage === 'designer-ready'

  return (
    <div
      className={`grid h-full min-h-0 gap-5 px-6 py-6 motion-safe:transition-[grid-template-columns] motion-safe:duration-[220ms] motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
        ready ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,720px)] justify-center'
      }`}
    >
      <ConversationPane
        session={session}
        starting={starting}
        errorMessage={errorMessage}
        specialistName="Frontend Designer"
        specialistSubline={
          ready
            ? `${mockups.length} screen${mockups.length === 1 ? '' : 's'} ready · ask for a change anytime`
            : 'Drafting the screens — describe what you want in the terminal'
        }
        isLive={isLive}
      />
      {ready ? (
        <DesignerReviewPane
          mockups={mockups}
          mockupsDirectoryPath={mockupsDirectoryPath}
          uiDirectionPath={uiDirectionPath}
          productDirectoryPath={productDirectoryPath}
        />
      ) : null}
    </div>
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
  sprintEngineRoleRegistry,
  sprintEngineDisabledRoleIds,
}: {
  runtimeState: GuidedBriefRuntimeState
  onChange: (next: GuidedBriefRuntimeState) => void
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
        [role]: runtimeState.buildRoleCliDefaults[role] ?? 'claude',
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
    <div className="flex h-full items-start justify-center overflow-auto px-6 py-6">
      <div className="flex w-full max-w-[760px] flex-col gap-4 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-5">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold text-[color:var(--text-strong)]">
            Ready to start the Sprint Engine build
          </span>
          <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            The generated handoff will become the plan source for the new Sprint Engine team.
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {checklist.map((item) => (
            <div
              key={`${item.label}:${item.path}`}
              className="flex min-w-0 items-start justify-between gap-3 rounded-md border border-[color:var(--bg-surface-raised)] px-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[12px] font-medium text-[color:var(--text-default)]">{item.label}</span>
                <span className="truncate font-mono text-[11px] text-[color:var(--text-muted)]">{item.path}</span>
              </div>
              {item.hash ? (
                <span className="shrink-0 font-mono text-[11px] text-[color:var(--text-subtle)]">
                  {item.hash.slice(0, 10)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2 border-t border-[color:var(--bg-surface-raised)] pt-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-medium text-[color:var(--text-default)]">
              Build roster
            </span>
            <span className="text-[11px] tabular-nums text-[color:var(--text-muted)]">
              {totalAgents} specialist{totalAgents === 1 ? '' : 's'}
            </span>
          </div>
          <SprintEngineRosterTable
            roleCounts={visibleRoleCounts}
            roleCliDefaults={runtimeState.buildRoleCliDefaults}
            registry={sprintEngineRoleRegistry}
            disabledRoleIds={sprintEngineDisabledRoleIds}
            disabled={false}
            onSetCount={setBuildRoleCount}
            onSetCli={setBuildRoleCli}
          />
        </div>
        <div className="flex flex-col gap-2 border-t border-[color:var(--bg-surface-raised)] pt-4">
          <span className="text-[12px] font-medium text-[color:var(--text-default)]">
            Run settings
          </span>
          <div className="overflow-hidden rounded-md border border-[color:var(--border-default)]">
            <CliPermissionPresetRow
              preset={runtimeState.buildCliPermissionPreset}
              onChange={(preset) => onChange({ ...runtimeState, buildCliPermissionPreset: preset })}
            />
            <div className="flex flex-col gap-2 border-t border-[color:var(--border-default)] px-3.5 py-3">
              <div>
                <span className="block text-[12px] font-medium text-[color:var(--text-default)]">
                  Automation
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                  How Sprint Engine should continue after this workspace opens.
                </span>
              </div>
              <div className="grid gap-2" role="radiogroup" aria-label="Sprint Engine automation mode">
                {sprintEngineAutomationModeOptions.map((option) => (
                  <PathRadio
                    key={option.value}
                    checked={automationMode === option.value}
                    label={option.label}
                    hint={option.hint}
                    onSelect={() => setAutomationMode(option.value)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
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
  )
}
