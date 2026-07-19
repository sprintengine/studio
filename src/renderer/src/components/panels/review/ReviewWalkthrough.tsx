import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'

import type {
  ChangeSetFile,
  DiffView,
  ReviewAnnotation,
  ReviewBrief,
  ReviewChangeSet,
} from '../../../../../shared/review'
import { TopBar } from './TopBar'
import { StepRail } from './StepRail'
import { StepPane } from './StepPane'
import { OverviewPane } from './OverviewPane'
import { AnnotationsPanel } from './AnnotationsPanel'
import {
  OVERVIEW_PANE_ID,
  buildRailModel,
  orderedSteps,
  sourceIdentity,
  statsChip,
} from './reviewSelectors'

export interface ReviewWalkthroughProps {
  changeset: ReviewChangeSet
  brief: ReviewBrief
  // Controlled reviewer state — the container owns persistence.
  readFiles: ReadonlySet<string>
  diffView: DiffView
  activePaneId: string
  monacoTheme: 'vs' | 'vs-dark'
  rerunning: boolean
  onSetActivePane: (id: string) => void
  onSetDiffView: (view: DiffView) => void
  onToggleRead: (path: string) => void
  onRequestComment: (path: string, line: number) => void
  onAskGuide: (annotation: ReviewAnnotation) => void
  onRerun: () => void
  // MC-1685 supplies the change map; T7 reserves the slot.
  changeMapSlot?: ReactNode
}

// The guided walkthrough — a pure projection of a validated changeset + brief +
// reviewer state. It renders no judgments and takes no action on the code: three
// columns (step rail, active pane, the step's notes) under a source-identity top
// bar. All mutation flows up through callbacks the container wires to state.
export function ReviewWalkthrough({
  changeset,
  brief,
  readFiles,
  diffView,
  activePaneId,
  monacoTheme,
  rerunning,
  onSetActivePane,
  onSetDiffView,
  onToggleRead,
  onRequestComment,
  onAskGuide,
  onRerun,
  changeMapSlot,
}: ReviewWalkthroughProps) {
  const steps = useMemo(() => orderedSteps(brief), [brief])
  const rail = useMemo(() => buildRailModel(changeset, brief, readFiles), [changeset, brief, readFiles])
  const fileByPath = useMemo(
    () => new Map<string, ChangeSetFile>(changeset.files.map((file) => [file.path, file])),
    [changeset],
  )
  const paneOrder = useMemo(() => [OVERVIEW_PANE_ID, ...steps.map((step) => step.id)], [steps])
  const activeStep = steps.find((step) => step.id === activePaneId) ?? null

  const revealMapRef = useRef<Map<string, (line: number) => void>>(new Map())
  const centerRef = useRef<HTMLDivElement | null>(null)

  const registerReveal = useCallback((path: string, reveal: ((line: number) => void) | null) => {
    if (reveal) revealMapRef.current.set(path, reveal)
    else revealMapRef.current.delete(path)
  }, [])

  // Orphaned annotations already show in the side panel (which lists every step
  // annotation); this hook is the reporting sink so the surface stays quiet.
  const handleOrphans = useCallback(() => {}, [])

  const handleJumpTo = useCallback((annotation: ReviewAnnotation) => {
    const card = centerRef.current?.querySelector<HTMLElement>(`[data-review-file="${annotation.path}"]`)
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    revealMapRef.current.get(annotation.path)?.(annotation.anchor.startLine)
  }, [])

  // [ and ] step through the panes (Overview + steps), skipping when focus is
  // inside a code editor so the keys stay usable for typing elsewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '[' && event.key !== ']') return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('.monaco-editor') || target.isContentEditable)) return
      const current = paneOrder.indexOf(activePaneId)
      if (current === -1) return
      const next = event.key === ']' ? current + 1 : current - 1
      if (next < 0 || next >= paneOrder.length) return
      event.preventDefault()
      onSetActivePane(paneOrder[next])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paneOrder, activePaneId, onSetActivePane])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[color:var(--bg-surface)]">
      <TopBar
        title={changeset.title}
        source={sourceIdentity(changeset)}
        stats={statsChip(changeset)}
        complexity={brief.overview.complexity}
        diffView={diffView}
        onSetDiffView={onSetDiffView}
        onRerun={onRerun}
        rerunning={rerunning}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[244px_minmax(0,1fr)_276px]">
        <StepRail rail={rail} activePaneId={activePaneId} onSelectPane={onSetActivePane} />
        <div ref={centerRef} className="min-w-0 overflow-y-auto px-6 py-5">
          <div key={activePaneId} className="review-pane-enter">
            {activeStep ? (
              <StepPane
                step={activeStep}
                fileByPath={fileByPath}
                readFiles={readFiles}
                diffView={diffView}
                monacoTheme={monacoTheme}
                onToggleRead={onToggleRead}
                onRequestComment={onRequestComment}
                onAskGuide={onAskGuide}
                onOrphans={handleOrphans}
                registerReveal={registerReveal}
              />
            ) : (
              <OverviewPane
                overview={brief.overview}
                knowledgeRefs={brief.knowledgeRefs}
                unassignedPaths={brief.coverage.unassignedPaths}
                changeMapSlot={changeMapSlot}
              />
            )}
          </div>
        </div>
        {activeStep ? (
          <AnnotationsPanel annotations={activeStep.annotations} onJumpTo={handleJumpTo} onAskGuide={onAskGuide} />
        ) : (
          <div className="border-l border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-4 py-4">
            <span className="mb-2.5 block text-[11px] font-medium text-[color:var(--text-subtle)]">In this step</span>
            <p className="text-[12px] leading-5 text-[color:var(--text-subtle)]">
              Pick a step to see the guide’s notes for it.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default ReviewWalkthrough
