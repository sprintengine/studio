import { Fragment, forwardRef, useRef, type KeyboardEvent } from 'react'
import { LifecycleGlyph, TruncatedText } from '../../ui'
import type { MultiloopMilestone, MultiloopMilestoneStatus } from '../../../types/workspace'
import { milestoneStatusLabels, milestoneStatusLifecycle } from './helpers'

// ===========================================================================
// CAMPAIGN TIMELINE — horizontal milestone stations on a hairline rail.
// ===========================================================================

export type CampaignTimelineProps = {
  milestones: MultiloopMilestone[]
  activeMilestoneId: string | null
  selectedMilestoneId: string | null
  onSelect: (milestoneId: string) => void
}

function CampaignTimelineImpl(
  { milestones, activeMilestoneId, selectedMilestoneId, onSelect }: CampaignTimelineProps,
  ref: React.ForwardedRef<HTMLOListElement>
) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = Math.min(milestones.length - 1, index + 1)
    if (event.key === 'ArrowLeft') nextIndex = Math.max(0, index - 1)
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = milestones.length - 1
    const target = milestones[nextIndex]
    if (!target) return
    onSelect(target.id)
    window.requestAnimationFrame(() => buttonRefs.current[target.id]?.focus())
  }

  return (
    <nav
      aria-label="Campaign timeline"
      className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-3 py-2"
    >
      <ol
        ref={ref}
        className="flex min-w-0 items-stretch gap-0 overflow-x-auto scroll-smooth"
      >
        {milestones.map((milestone, index) => {
          const isSelected = milestone.id === selectedMilestoneId
          const isActive = milestone.id === activeMilestoneId
          return (
            <Fragment key={milestone.id}>
              {index > 0 ? (
                <TimelineConnector
                  fromStatus={milestones[index - 1].status}
                  toStatus={milestone.status}
                />
              ) : null}
              <li className="flex min-w-[10rem] max-w-[14rem] flex-1 flex-col">
                <TimelineStation
                  ref={(node) => {
                    buttonRefs.current[milestone.id] = node
                  }}
                  milestone={milestone}
                  index={index}
                  isSelected={isSelected}
                  isActive={isActive}
                  onSelect={() => onSelect(milestone.id)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                />
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}

export const CampaignTimeline = forwardRef<HTMLOListElement, CampaignTimelineProps>(CampaignTimelineImpl)
CampaignTimeline.displayName = 'CampaignTimeline'

function TimelineConnector({ fromStatus, toStatus }: { fromStatus: MultiloopMilestoneStatus; toStatus: MultiloopMilestoneStatus }) {
  const colorVar = fromStatus === 'accepted' || toStatus === 'accepted'
    ? 'var(--accent-primary)'
    : fromStatus === 'blocked' || toStatus === 'blocked'
      ? 'var(--tone-warn)'
      : 'var(--border-default)'
  return (
    <div aria-hidden="true" className="relative flex min-w-[1.25rem] flex-1 items-center px-1">
      <div className="h-px w-full" style={{ backgroundColor: colorVar }} />
    </div>
  )
}

type TimelineStationProps = {
  milestone: MultiloopMilestone
  index: number
  isSelected: boolean
  isActive: boolean
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function TimelineStationImpl(
  { milestone, index, isSelected, isActive, onSelect, onKeyDown }: TimelineStationProps,
  ref: React.ForwardedRef<HTMLButtonElement>
) {
  const containerClass = isSelected
    ? 'bg-[color:var(--accent-primary-soft)] border-l-2 border-[color:var(--accent-primary)]'
    : 'border-l-2 border-transparent hover:bg-[color:var(--bg-hover)]'

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      aria-pressed={isSelected}
      aria-current={isActive ? 'step' : undefined}
      className={`group flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${containerClass}`}
    >
      <LifecycleGlyph
        state={milestoneStatusLifecycle[milestone.status]}
        live={isActive}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
          <span className="tabular-nums">M{index + 1}</span>
          <span>·</span>
          <span>{milestoneStatusLabels[milestone.status]}</span>
          {milestone.sprintEngine ? (
            <>
              <span>·</span>
              <span>Sprint</span>
            </>
          ) : null}
        </div>
        <TruncatedText
          as="div"
          multiline
          text={milestone.title}
          className="line-clamp-2 text-[12px] font-medium leading-[1.3] text-[color:var(--text-strong)]"
        />
      </div>
    </button>
  )
}

const TimelineStation = forwardRef<HTMLButtonElement, TimelineStationProps>(TimelineStationImpl)
TimelineStation.displayName = 'TimelineStation'

