import { DefinitionList, GhostButton, LifecycleGlyph, PrimaryButton, Section, StatusDot, type DefinitionItem } from '../../ui'
import type { MultiloopMilestone, SprintEngineState } from '../../../types/workspace'
import type { MultiloopExecutionReadiness } from '../../../utils/multiloop'
import { formatCount, ListBlock, milestoneStatusLabels, milestoneStatusLifecycle, readinessLabel, readinessTone, toProjectRelativePath, type LinkedExecutionReadState } from './helpers'

// ===========================================================================
// SPRINT CONSOLE — selected milestone summary + execution source strip.
// ===========================================================================

export function SprintConsole({
  milestone,
  milestoneIndex,
  activeMilestoneId,
  readiness,
  blockersCount,
  linkedSprintEngineState,
  linkedExecutionReadState,
  workspaceRoot,
  onOpenStateFile,
}: {
  milestone: MultiloopMilestone | null
  milestoneIndex: number
  activeMilestoneId: string | null
  readiness: MultiloopExecutionReadiness
  blockersCount: number
  linkedSprintEngineState: SprintEngineState | null
  linkedExecutionReadState: LinkedExecutionReadState
  workspaceRoot: string | null
  onOpenStateFile: (link: NonNullable<MultiloopMilestone['sprintEngine']>) => void
}) {
  if (!milestone) {
    return (
      <Section title="Sprint">
        <p className="text-[12px] text-[color:var(--text-muted)]">
          No milestone selected. Pick a station from the timeline.
        </p>
      </Section>
    )
  }

  const isActive = milestone.id === activeMilestoneId
  const tone = readinessTone(readiness)
  const sprintLabel = `${isActive ? 'Active sprint' : 'Sprint'} M${milestoneIndex + 1}`
  const sourceLabel = milestone.sprintEngine ? 'Sprint' : 'Multiloop'
  const linkedRelativePath = milestone.sprintEngine
    ? toProjectRelativePath(milestone.sprintEngine.statePath, workspaceRoot)
    : null

  const details: DefinitionItem[] = [
    { term: 'Sprint', description: sprintLabel },
    {
      term: 'Status',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <LifecycleGlyph state={milestoneStatusLifecycle[milestone.status]} live={false} />
          <span>{milestoneStatusLabels[milestone.status]}</span>
        </span>
      ),
    },
    {
      term: 'Readiness',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={tone} />
          <span>{readinessLabel(readiness)}</span>
        </span>
      ),
    },
    { term: 'Source', description: sourceLabel },
  ]
  if (blockersCount > 0) {
    details.push({
      term: 'Blockers',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone="warn" />
          <span>{formatCount(blockersCount, 'blocker')}</span>
        </span>
      ),
    })
  }

  return (
    <Section title={milestone.title} headingId={`sprint-${milestone.id}`}>
      <DefinitionList items={details} />
      {milestone.goal ? (
        <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
          {milestone.goal}
        </p>
      ) : null}
      {linkedRelativePath && milestone.sprintEngine ? (
        <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
          <span>{linkedSprintEngineState?.name || milestone.sprintEngine.teamSlug}</span>
          <span aria-hidden="true" className="mx-1.5">·</span>
          <button
            type="button"
            onClick={() => onOpenStateFile(milestone.sprintEngine!)}
            className="break-all font-mono text-[11px] text-[color:var(--accent-primary)] underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
          >
            {linkedRelativePath}
          </button>
          {linkedExecutionReadState.status === 'loading' ? (
            <>
              <span aria-hidden="true" className="mx-1.5">·</span>
              <span>Reading state…</span>
            </>
          ) : null}
        </p>
      ) : null}
      {(milestone.entryCriteria.length > 0 || milestone.acceptanceCriteria.length > 0) ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <ListBlock title="Entry criteria" items={milestone.entryCriteria} />
          <ListBlock title="Acceptance criteria" items={milestone.acceptanceCriteria} />
        </div>
      ) : null}
      {milestone.finalGoalContribution ? (
        <div className="mt-3">
          <div className="text-[11px] text-[color:var(--text-muted)]">Final goal contribution</div>
          <p className="mt-1 text-[12px] leading-[1.5] text-[color:var(--text-default)]">{milestone.finalGoalContribution}</p>
        </div>
      ) : null}
    </Section>
  )
}

export function ExecutionUnavailable({
  link,
  readState,
  workspaceRoot,
  onRetry,
  onOpenStateFile,
  onOpenCoordinator,
}: {
  link: NonNullable<MultiloopMilestone['sprintEngine']>
  readState: Extract<LinkedExecutionReadState, { status: 'error' }>
  workspaceRoot: string | null
  onRetry: () => void
  onOpenStateFile: () => void
  onOpenCoordinator: () => void
}) {
  return (
    <Section title="Execution unavailable">
      <div className="flex items-start gap-2">
        <StatusDot tone="error" className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] leading-[1.5] text-[color:var(--text-default)]">
            Sprint state for {link.teamSlug} is not readable.
          </p>
          <p className="mt-1 break-all font-mono text-[11px] leading-[1.4] text-[color:var(--tone-error)]">
            {toProjectRelativePath(readState.path || link.statePath, workspaceRoot)}
          </p>
          <p className="mt-1 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">
            {readState.message}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <PrimaryButton type="button" onClick={onRetry}>Retry</PrimaryButton>
            <GhostButton type="button" onClick={onOpenStateFile}>Open state file</GhostButton>
            <GhostButton type="button" onClick={onOpenCoordinator}>Open coordinator</GhostButton>
          </div>
        </div>
      </div>
    </Section>
  )
}

