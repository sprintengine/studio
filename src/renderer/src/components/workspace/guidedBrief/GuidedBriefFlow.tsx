import { useEffect, useState } from 'react'
import type { AgentCli, CliRuntimeSettings } from '../../../../../shared/electron-api'
import {
  snapshotGuidedBriefArtifact,
  GuidedBriefWorkspaceError,
  writeGuidedBriefBuildHandoff,
} from '../../../utils/guidedBriefWorkspace'
import { StatusDot, Tooltip } from '../../ui'
import { ConversationPane, type ConversationView } from './ConversationPane'
import { MockupPreviewPane } from './MockupPreviewPane'
import { RenderedBriefPane } from './RenderedBriefPane'
import { useDesignerSession, type DesignerMockupFile } from './useDesignerSession'
import { useStrategistSession } from './useStrategistSession'
import { joinWorkspacePath } from './paths'
import {
  guidedBriefBuildHandoffRelativePath,
  guidedBriefHandoffChecklist,
} from './handoff'
import {
  progressForStage,
  stepCounterLabel,
  type GuidedBriefAcceptedArtifact,
  type GuidedBriefRuntimeState,
  type GuidedBriefStage,
} from './types'

export type GuidedBriefRunOptions = {
  startRunner: boolean
  autoApproveArtifacts: boolean
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
  cli: AgentCli
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
}

export function GuidedBriefFlow({
  runtimeState,
  onChange,
  onBackToIdea,
  onClose,
  onStartBuild,
  cli,
  cliRuntimes,
}: Props) {
  const { stage, hasUi, workspaceRoot, workspaceName, acceptedProductBrief } = runtimeState
  const progress = progressForStage(stage, hasUi)
  const counter = stepCounterLabel(stage, hasUi)
  const inStrategistStage = stage === 'strategist-working' || stage === 'strategist-ready'
  const inDesignerStage = stage === 'designer-working' || stage === 'designer-ready'

  const strategist = useStrategistSession({
    workspaceRoot,
    cli,
    cliRuntimes,
    enabled: inStrategistStage,
  })

  // The designer reads the accepted product brief from product/.versions/<sha>.md.
  // The terminal session is spawned with cwd=workspaceRoot, so the agent sees
  // a project-relative path, matching the project's path-rule for agent prompts.
  const acceptedBriefRelativePath = acceptedProductBrief?.path ?? null
  const designer = useDesignerSession({
    workspaceRoot,
    acceptedBriefSnapshotPath: acceptedBriefRelativePath ?? '',
    cli,
    cliRuntimes,
    enabled:
      hasUi === 'yes' &&
      acceptedBriefRelativePath !== null &&
      inDesignerStage,
  })

  // Strategist working → ready as soon as a real signal arrives.
  useEffect(() => {
    if (stage === 'strategist-working' && strategist.readiness.isReady) {
      onChange({ ...runtimeState, stage: 'strategist-ready' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, strategist.readiness.isReady])

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
  const [conversationView, setConversationView] = useState<ConversationView>('raw')
  const [startRunner, setStartRunner] = useState(true)
  const [autoApproveArtifacts, setAutoApproveArtifacts] = useState(false)
  const showTerminalDisclosure = inStrategistStage || inDesignerStage

  const effectiveAutoApprove = startRunner && autoApproveArtifacts

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
      const nextStage: GuidedBriefStage = hasUi === 'yes' ? 'designer-working' : 'handoff'
      const nextState = {
        ...runtimeState,
        stage: nextStage,
        acceptedProductBrief: accepted,
      }
      if (hasUi === 'no') {
        await writeGuidedBriefBuildHandoff({
          workspaceRoot,
          idea: runtimeState.idea,
          hasUi,
          productBrief: accepted,
          confirmedDecisions: ['No visual UI is required.'],
          filesystem: {
            ensureDir: window.api.ensureDir,
            readFile: window.api.readfile,
            writeFile: window.api.writefile,
          },
        })
      }
      onChange(nextState)
    } catch (error) {
      setAcceptError(formatAcceptError(error, 'brief'))
    } finally {
      setAccepting(false)
    }
  }

  const acceptDesignerMockups = async () => {
    // Real-file evidence: every mockup file in mockups/ is snapshotted.
    if (!designer.readiness.mockupsAvailable) return
    if (!runtimeState.acceptedProductBrief) {
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
        uiDirection: acceptedUiDirection,
        mockups: acceptedMockups,
        confirmedDecisions: ['Application includes a visual UI.'],
        validationNotes: ['Validate implementation against the accepted brief, UI direction, and mockup snapshot hashes.'],
        filesystem: {
          ensureDir: window.api.ensureDir,
          readFile: window.api.readfile,
          writeFile: window.api.writefile,
        },
      })
      onChange({
        ...runtimeState,
        stage: 'handoff',
        acceptedUiDirection,
        acceptedMockups,
      })
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
    designer,
    onAcceptStrategist: () => void acceptStrategistBrief(),
    onAcceptDesigner: () => void acceptDesignerMockups(),
    onStartBuild: () => void startBuild(),
  })

  const startBuild = async () => {
    if (stage !== 'handoff') return
    setStartingBuild(true)
    setStartBuildError(null)
    try {
      await onStartBuild(runtimeState, {
        startRunner,
        autoApproveArtifacts: effectiveAutoApprove,
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
        <GuidedProgress total={progress.total} active={progress.active} done={progress.done} />
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="
              ml-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[color:var(--text-subtle)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
            "
          >
            <svg className="icon-md" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
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
            conversationView={conversationView}
          />
        ) : inDesignerStage ? (
          <DesignerBody
            stage={stage}
            session={designer.session}
            starting={designer.status === 'starting' || designer.status === 'idle'}
            errorMessage={designer.error}
            isLive={designer.status === 'running' || designer.status === 'ready'}
            mockups={designer.mockups}
            mockupsDirectoryPath={designer.mockupsDirectoryPath}
            workspaceRoot={workspaceRoot}
            inspirationDirectoryPath={designer.inspirationDirectoryPath}
            conversationView={conversationView}
          />
        ) : (
          <HandoffBody
            runtimeState={runtimeState}
            startRunner={startRunner}
            onChangeStartRunner={setStartRunner}
            autoApproveArtifacts={autoApproveArtifacts}
            onChangeAutoApproveArtifacts={setAutoApproveArtifacts}
          />
        )}
      </main>

      <footer className="flex shrink-0 items-center gap-3 border-t border-[color:var(--bg-surface-raised)] px-5 py-3">
        {showTerminalDisclosure ? (
          <button
            type="button"
            onClick={() =>
              setConversationView((current) => (current === 'raw' ? 'parsed' : 'raw'))
            }
            aria-pressed={conversationView === 'raw'}
            className="
              text-[12px] text-[color:var(--text-muted)] underline-offset-2 transition-colors
              hover:text-[color:var(--text-default)] hover:underline
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
            "
          >
            {conversationView === 'raw' ? 'Show transcript' : 'Show terminal'}
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--text-subtle)]">
          {counter}
        </span>
        {stage === 'designer-working' ? (
          <DesignerReadinessHint readiness={designer.readiness} />
        ) : null}
        {acceptError ? (
          <span className="truncate text-[12px] text-[color:var(--tone-error)]">{acceptError}</span>
        ) : null}
        {startBuildError ? (
          <span className="truncate text-[12px] text-[color:var(--tone-error)]">{startBuildError}</span>
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
        {primaryAction}
      </footer>
    </section>
  )
}

function formatAcceptError(error: unknown, kind: 'brief' | 'mockup'): string {
  if (error instanceof GuidedBriefWorkspaceError) return `Could not snapshot the ${kind} (${error.code}).`
  if (error instanceof Error) return error.message
  return `Could not snapshot the ${kind}.`
}

function titleForMockup(mockup: DesignerMockupFile): string {
  const base = mockup.name.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim()
  return base ? base.replace(/\b\w/g, (char) => char.toUpperCase()) : mockup.name
}

function renderPrimaryAction({
  stage,
  accepting,
  startingBuild,
  strategist,
  designer,
  onAcceptStrategist,
  onAcceptDesigner,
  onStartBuild,
}: {
  stage: GuidedBriefStage
  accepting: boolean
  startingBuild: boolean
  strategist: ReturnType<typeof useStrategistSession>
  designer: ReturnType<typeof useDesignerSession>
  onAcceptStrategist: () => void
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
  if (stage === 'designer-ready') {
    const disabled = !designer.readiness.mockupsAvailable || !designer.readiness.uiDirectionReady || accepting
    return (
      <PrimaryButton onClick={onAcceptDesigner} disabled={disabled}>
        {accepting ? 'Accepting…' : 'Accept · continue'}
      </PrimaryButton>
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

function PrimaryButton({
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

function GuidedProgress({ total, active, done }: { total: number; active: number; done: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={Math.min(total, active + 1)}
      aria-label={`Step ${Math.min(total, active + 1)} of ${total}`}
      className="flex min-w-0 flex-1 items-center gap-1.5"
    >
      {Array.from({ length: total }).map((_, idx) => {
        const isCurrent = idx === active
        const isDone = idx < done && !isCurrent
        return (
          <span
            key={idx}
            aria-hidden="true"
            className={`h-[3px] flex-1 rounded-full transition-colors duration-300 ${
              isCurrent
                ? 'bg-[color:var(--text-strong)]'
                : isDone
                  ? 'bg-[color:var(--text-disabled)]'
                  : 'bg-[color:var(--border-default)]'
            }`}
          />
        )
      })}
    </div>
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
  conversationView,
}: {
  stage: GuidedBriefStage
  session: ReturnType<typeof useStrategistSession>['session']
  starting: boolean
  errorMessage: string | null
  isLive: boolean
  requirementsPath: string
  productDirectoryPath: string
  conversationView: ConversationView
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
            : 'Asking about the idea — answer in plain English'
        }
        isLive={isLive}
        composerPlaceholder={ready ? 'Ask a change or add a detail…' : 'Type your answer. Plain English.'}
        view={conversationView}
      />
      {ready ? (
        <RenderedBriefPane briefPath={requirementsPath} watchDirectoryPath={productDirectoryPath} />
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
  mockupsDirectoryPath,
  workspaceRoot,
  inspirationDirectoryPath,
  conversationView,
}: {
  stage: GuidedBriefStage
  session: ReturnType<typeof useDesignerSession>['session']
  starting: boolean
  errorMessage: string | null
  isLive: boolean
  mockups: DesignerMockupFile[]
  mockupsDirectoryPath: string
  workspaceRoot: string
  inspirationDirectoryPath: string
  conversationView: ConversationView
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
            : 'Drafting the screens — paste inspiration or describe what you want'
        }
        isLive={isLive}
        composerPlaceholder={
          ready
            ? 'Ask for a change to the screen on the right…'
            : 'Describe the look, or paste an inspiration screenshot.'
        }
        imagePaste={{ workspaceRoot, inspirationDirectoryPath }}
        view={conversationView}
      />
      {ready ? (
        <MockupPreviewPane mockups={mockups} watchDirectoryPath={mockupsDirectoryPath} />
      ) : null}
    </div>
  )
}

function HandoffBody({
  runtimeState,
  startRunner,
  onChangeStartRunner,
  autoApproveArtifacts,
  onChangeAutoApproveArtifacts,
}: {
  runtimeState: GuidedBriefRuntimeState
  startRunner: boolean
  onChangeStartRunner: (value: boolean) => void
  autoApproveArtifacts: boolean
  onChangeAutoApproveArtifacts: (value: boolean) => void
}) {
  const [handoffStatus, setHandoffStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const handoffPath = joinWorkspacePath(runtimeState.workspaceRoot, guidedBriefBuildHandoffRelativePath())
  const checklist = guidedBriefHandoffChecklist(runtimeState)

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
    <div className="flex h-full items-center justify-center px-6 py-6">
      <div className="flex w-full max-w-[560px] flex-col gap-4 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-5">
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
          <span className="text-[12px] font-medium text-[color:var(--text-default)]">
            Run settings
          </span>
          <label className="flex items-start justify-between gap-3 py-0.5">
            <span className="min-w-0">
              <span className="block text-[12px] font-medium text-[color:var(--text-default)]">
                Start roster runner when workspace opens
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                Launch the Sprint Engine specialists in the background as soon as the workspace mounts.
              </span>
            </span>
            <input
              type="checkbox"
              checked={startRunner}
              onChange={(event) => onChangeStartRunner(event.currentTarget.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-primary)]"
            />
          </label>
          <label
            className={`flex items-start justify-between gap-3 py-0.5 ${
              startRunner ? '' : 'opacity-60'
            }`}
          >
            <span className="min-w-0">
              <span className="block text-[12px] font-medium text-[color:var(--text-default)]">
                Approve all artifacts
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                Auto-approve artifacts as agents publish them so the runner does not stall.
              </span>
            </span>
            <input
              type="checkbox"
              checked={autoApproveArtifacts}
              disabled={!startRunner}
              onChange={(event) => onChangeAutoApproveArtifacts(event.currentTarget.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-primary)] disabled:cursor-not-allowed"
            />
          </label>
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
