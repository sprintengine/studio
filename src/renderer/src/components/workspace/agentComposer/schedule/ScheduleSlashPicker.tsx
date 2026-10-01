import React from 'react'

import { MenuOption, Popover } from '../../../ui'
import { ScheduleGlyph } from '../../../AppIcons'
import { describeCronSchedule, parseCronSchedule } from '../../../../../../shared/cron'
import { scheduleSuggestionsFor, type ScheduleSuggestion } from '../../../../../../shared/schedule-phrases'
import { readRecentSchedules } from './recentSchedules'

export type ScheduleSlashPickerHandle = {
  /** Move the highlight; false when there is nothing to move through. */
  moveSelection: (delta: number) => boolean
  /** Use the highlighted schedule; false when there is none. */
  pickActive: () => boolean
}

/**
 * `/schedule` typed at the end of the prompt: the schedule said in plain words
 * after it ("every weekday at 9"), read as it is typed, with the schedules used
 * last offered before anything is. Picking one takes the `/schedule …` words
 * back out of the prompt and makes the launch a scheduled agent on that
 * schedule. Drawn over the prompt box the way the skill type-ahead is, and
 * driven from the prompt's own keys, so focus never leaves the text.
 */
export const ScheduleSlashPicker = React.forwardRef<
  ScheduleSlashPickerHandle,
  { query: string; onPick: (suggestion: ScheduleSuggestion) => void; onDismiss: () => void }
>(function ScheduleSlashPicker({ query, onPick, onDismiss }, ref) {
  const options = React.useMemo<ScheduleSuggestion[]>(() => {
    if (query.trim()) return scheduleSuggestionsFor(query)
    return readRecentSchedules().flatMap((cron) => {
      const parsed = parseCronSchedule(cron)
      return parsed.ok ? [{ cron, words: describeCronSchedule(parsed.schedule) }] : []
    })
  }, [query])
  const [active, setActive] = React.useState(0)
  React.useEffect(() => setActive(0), [query])
  const clamped = Math.min(active, Math.max(0, options.length - 1))

  React.useImperativeHandle(
    ref,
    () => ({
      moveSelection: (delta) => {
        if (options.length === 0) return false
        setActive((current) => (current + delta + options.length) % options.length)
        return true
      },
      pickActive: () => {
        const option = options[clamped]
        if (!option) return false
        onPick(option)
        return true
      },
    }),
    [clamped, onPick, options],
  )

  return (
    <div className="pointer-events-none absolute inset-0 flex">
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) onDismiss()
        }}
        ariaLabel="Schedule this agent"
        popupRole="menu"
        placement="top-start"
        material="glass"
        className="w-full"
        renderTrigger={() => null}
        surfaceClassName="w-[min(360px,var(--popover-trigger-width))] max-w-[calc(100vw-16px)]"
      >
        <div className="flex flex-col py-1">
          {options.length === 0 ? (
            <p className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">
              {query.trim()
                ? 'Say when — “every weekday at 9”, “sundays 9pm”, “every 2 hours”, or cron.'
                : 'Say when — “every weekday at 9”, “daily at 9am and 1pm”, or cron.'}
            </p>
          ) : (
            <>
              {query.trim() ? null : (
                <p className="px-2.5 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Recent</p>
              )}
              {options.map((option, index) => (
                <MenuOption
                  key={option.cron}
                  role="menuitemradio"
                  selected={index === clamped}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(index)}
                  // Kept off the prompt's focus: the pick happens on mousedown.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    onPick(option)
                  }}
                  icon={
                    <ScheduleGlyph
                      className={`icon-xs shrink-0 ${index === clamped ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-subtle)]'}`}
                    />
                  }
                  trailing={
                    <span className="shrink-0 font-mono text-micro text-[color:var(--text-subtle)]">{option.cron}</span>
                  }
                >
                  {option.words}
                </MenuOption>
              ))}
            </>
          )}
          <div className="mt-1 border-t border-[color:var(--border-subtle)] px-2.5 pt-1.5 text-micro text-[color:var(--text-subtle)]">
            ↑↓ choose · ⏎ schedule · esc dismiss
          </div>
        </div>
      </Popover>
    </div>
  )
})
