import { useState } from 'react'
import { DefinitionList, StatusDot, type DefinitionItem, type Tone } from '../../ui'
import type { MultiloopMilestone } from '../../../types/workspace'
import { getMultiloopRole, type MultiloopRole } from '../../../specialists/specialistActions'
import { formatCount } from './helpers'

// ===========================================================================
// CAMPAIGN SUMMARY — one-line meta crumb under PanelHeader with on-demand
// details disclosure. The crumb keeps first content (TaskBoard) close to the
// top; the full DefinitionList only renders when the user opens it or expands
// the goal.
// ===========================================================================

export function CampaignSummary({
  iteration,
  activeMilestone,
  activeMilestoneIndex,
  ownership,
  readiness,
  readinessTone: readinessToneValue,
  blockersCount,
  autoRunLabel,
  autoRunPaused,
  fullGoal,
  goalPreview,
  canExpandGoal,
  goalExpanded,
  onToggleGoal,
  launchError,
}: {
  iteration: number
  activeMilestone: MultiloopMilestone | null
  activeMilestoneIndex: number
  ownership: string
  readiness: string
  readinessTone: Tone
  blockersCount: number
  autoRunLabel: string
  autoRunPaused: boolean
  fullGoal: string
  goalPreview: string
  canExpandGoal: boolean
  goalExpanded: boolean
  onToggleGoal: () => void
  launchError: { role: MultiloopRole; message: string } | null
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const sprintLabel = activeMilestone
    ? `M${activeMilestoneIndex + 1} · ${activeMilestone.title}`
    : 'No active sprint'

  const items: DefinitionItem[] = [
    {
      term: 'Active sprint',
      description: activeMilestone
        ? `M${activeMilestoneIndex + 1} · ${activeMilestone.title}`
        : 'None',
    },
    { term: 'Iteration', description: String(iteration) },
    { term: 'Owner', description: ownership },
    {
      term: 'Readiness',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={readinessToneValue} />
          <span>{readiness}</span>
        </span>
      ),
    },
    {
      term: 'Blockers',
      description: blockersCount > 0
        ? (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="warn" />
            <span>{formatCount(blockersCount, 'blocker')}</span>
          </span>
        )
        : 'None',
    },
    {
      term: 'Auto-run',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={autoRunPaused ? 'warn' : autoRunLabel === 'on' ? 'accent' : 'neutral'} />
          <span>{autoRunLabel}</span>
        </span>
      ),
    },
  ]

  return (
    <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-[color:var(--text-muted)]">
        <span className="truncate text-[color:var(--text-default)]">{sprintLabel}</span>
        <span aria-hidden="true">·</span>
        <span>Iteration {iteration}</span>
        <span aria-hidden="true">·</span>
        <span>Owner {ownership}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <StatusDot tone={readinessToneValue} />
          <span>{readiness}</span>
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <StatusDot tone={blockersCount > 0 ? 'warn' : 'neutral'} />
          <span>{blockersCount > 0 ? formatCount(blockersCount, 'blocker') : 'No blockers'}</span>
        </span>
        <button
          type="button"
          onClick={() => setDetailsOpen((current) => !current)}
          aria-expanded={detailsOpen}
          className="ml-auto text-[11px] text-[color:var(--accent-primary)] underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          {detailsOpen ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {detailsOpen ? (
        <div className="mt-2 max-w-3xl">
          <DefinitionList items={items} />
          <div className="mt-2">
            <p
              className={`text-[12px] leading-[1.5] text-[color:var(--text-default)] ${
                goalExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2'
              }`}
            >
              <span className="text-[color:var(--text-muted)]">Final goal: </span>
              {goalExpanded ? fullGoal : goalPreview}
            </p>
            {canExpandGoal ? (
              <button
                type="button"
                onClick={onToggleGoal}
                aria-expanded={goalExpanded}
                className="mt-1 text-[12px] text-[color:var(--accent-primary)] underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
              >
                {goalExpanded ? 'Show less' : 'Show more'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {launchError ? (
        <p className="mt-2 text-[12px] text-[color:var(--tone-error)]" role="status">
          {getMultiloopRole(launchError.role).label}: {launchError.message}
        </p>
      ) : null}
    </div>
  )
}

