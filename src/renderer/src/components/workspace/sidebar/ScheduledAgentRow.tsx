import React from 'react'

import { IconButton, Tooltip, WorkingMark } from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { ScheduleGlyph } from '../../AppIcons'
import CliIcon from '../../CliIcon'
import {
  scheduledAgentScheduleWords,
  scheduledAgentTitle,
  type ScheduledAgentView,
} from '../../../../../shared/scheduled-agents'
import { ProjectLine, type FlatProjectLine } from './rowParts'
import { SELECTED_ROW_ACCENT, SELECTION_EDGE_CLASS } from './rowStyle'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * When a scheduled agent runs next, in the seat where a chat's card says when
 * it last finished: "in 12m", "in 5h" within the day, "Sun 21:00" within the
 * week, "4 Oct" after that. A time still to come, so it always says "in" or a
 * day — never the bare "2h" a finished chat wears, which reads as "ago".
 */
export function nextRunLabel(nextRunAt: number | null, now: number): string | null {
  if (nextRunAt === null) return null
  const remaining = nextRunAt - now
  if (remaining <= MINUTE_MS) return 'now'
  if (remaining < HOUR_MS) return `in ${Math.ceil(remaining / MINUTE_MS)}m`
  if (remaining < DAY_MS) return `in ${Math.round(remaining / HOUR_MS)}h`
  const at = new Date(nextRunAt)
  if (remaining < 7 * DAY_MS) {
    const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    return `${WEEKDAY_SHORT[at.getDay()]} ${clock}`
  }
  return `${at.getDate()} ${MONTH_SHORT[at.getMonth()]}`
}

/** Whether the card still says its last run did not start: until the person opens it. */
export function scheduledAgentFailureUnseen(agent: ScheduledAgentView): string | null {
  const run = agent.lastRun
  if (!run || run.ok) return null
  return (agent.lastFailureSeenAt ?? 0) < run.at ? run.message : null
}

/**
 * A scheduled agent's card in the sidebar: the same card a chat has, so the
 * two read as one list — two lines in the project tree, three in All chats.
 * What differs is only what the lines say: the clock before the title; under
 * it the schedule in words (or, while its latest run's chat is working, the
 * working mark; or why its last run did not start, until opened); and in the
 * seat, when it runs next rather than when it last finished. × on hover closes
 * it, which stops the schedule.
 */
export function ScheduledAgentRow({
  agent,
  now,
  flatProject,
  working,
  selected,
  onOpen,
  onClose,
}: {
  agent: ScheduledAgentView
  now: number
  /** The project line the All chats list puts on top; absent in the tree. */
  flatProject?: FlatProjectLine
  /** Its latest run's chat is working right now. */
  working: boolean
  /** Open in the door this window is showing. */
  selected: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const title = scheduledAgentTitle(agent.prompt)
  const words = scheduledAgentScheduleWords(agent.schedule) ?? agent.schedule.cron
  const failure = scheduledAgentFailureUnseen(agent)
  const next = nextRunLabel(agent.nextRunAt, now)
  const nextFull = agent.nextRunAt === null ? null : new Date(agent.nextRunAt).toLocaleString()

  const seat = (
    <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end pl-2">
      <span className="inline-flex items-center gap-1 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
        {working ? (
          <WorkingMark label="Its run is working" seed={agent.id} />
        ) : next ? (
          <Tooltip content={`Next run ${nextFull}`}>
            <span className="text-meta tabular-nums text-[color:var(--text-muted)]">
              <span aria-hidden="true">{next}</span>
              <span className="sr-only">Runs next {nextFull}</span>
            </span>
          </Tooltip>
        ) : null}
      </span>
      {/* The one row action, revealed on hover and on focus so the keyboard
          can reach it: close, which is how a scheduled agent is switched off. */}
      <span className="pointer-events-none absolute inset-y-0 right-0 inline-flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <Tooltip content="Close — stops the schedule">
          <IconButton
            tone="quiet"
            aria-label={`Close scheduled agent: ${title}`}
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            <svg className="icon-xs" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M3.25 3.25L10.75 10.75M10.75 3.25L3.25 10.75"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
        </Tooltip>
      </span>
    </span>
  )

  return (
    <div
      role="treeitem"
      tabIndex={-1}
      aria-current={selected ? 'true' : undefined}
      aria-label={`Scheduled agent: ${title}. ${words}.${failure ? ` Last run did not start: ${failure}.` : ''}`}
      data-scheduled-agent={agent.id}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      // The chat card's own box — the same inset, rail, radius and rhythm —
      // so a scheduled agent sits in the list as one of its rows.
      // design-tokens-allow: alignment — the chat rows' 26px inset after their 4px rail, so the title lands on the sidebar's content column
      className={`interactive group relative mx-1.5 my-0.5 flex min-h-control-sm cursor-pointer select-none flex-col justify-center gap-0.5 rounded-md border-l-[4px] py-1 pr-1.5 text-heading ${
        flatProject ? 'pl-1.5' : 'pl-[26px]'
      } ${FOCUS_RING_CLASS} ${
        // Selected as a chat row is: the neutral fill and the edge ring, no bar.
        selected
          ? `border-l-transparent ${SELECTED_ROW_ACCENT.bg} ${SELECTED_ROW_ACCENT.text} ${SELECTION_EDGE_CLASS}`
          : 'border-l-transparent text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      {flatProject ? <ProjectLine project={flatProject}>{seat}</ProjectLine> : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <ScheduleGlyph className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
        <span className={`min-w-0 flex-1 truncate ${working || failure ? 'font-semibold' : ''}`}>{title}</span>
      </div>
      <div className="flex h-5 min-w-0 items-center gap-2 overflow-hidden text-meta text-[color:var(--text-subtle)]">
        {/* The ringed CLI mark a chat's line wears: each run is a chat on it. */}
        <span className="flex size-icon-sm shrink-0 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]">
          <CliIcon cli={agent.cli} className="icon-xs" />
        </span>
        <span className={`min-w-0 flex-1 truncate ${failure ? 'text-[color:var(--tone-error)]' : ''}`}>
          {working ? 'Running now' : failure ? `Failed — ${failure}` : words}
        </span>
        {flatProject ? null : seat}
      </div>
    </div>
  )
}
