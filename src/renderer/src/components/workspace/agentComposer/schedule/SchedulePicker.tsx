import React from 'react'

import { ChipButton, CloseIconButton, GhostButton, Input, Popover, SegmentedControl } from '../../../ui'
import { ScheduleGlyph } from '../../../AppIcons'
import { ComposerTray, ComposerTrayRow } from '../../../panels/agentChat/composerTray'
import { CRON_FIELD_NAMES, describeCronSchedule, parseCronSchedule } from '../../../../../../shared/cron'
import { nextScheduledAgentRuns } from '../../../../../../shared/scheduled-agents'
import {
  cronFromEditorState,
  editorStateFromCron,
  formatRunTimes,
  formatScheduleTime,
  parseScheduleTime,
  switchTab,
  type ScheduleEditorState,
  type ScheduleTab,
  type ScheduleTime,
} from './scheduleEditor'

const TABS: { value: ScheduleTab; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'cron', label: 'Cron' },
]

// Monday first, the way a working week is read; the values are cron's.
const WEEKDAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: 'M', name: 'Monday' },
  { value: 2, short: 'T', name: 'Tuesday' },
  { value: 3, short: 'W', name: 'Wednesday' },
  { value: 4, short: 'T', name: 'Thursday' },
  { value: 5, short: 'F', name: 'Friday' },
  { value: 6, short: 'S', name: 'Saturday' },
  { value: 0, short: 'S', name: 'Sunday' },
]

const FIELD_LABEL: Record<(typeof CRON_FIELD_NAMES)[number], string> = {
  minute: 'min',
  hour: 'hour',
  day: 'day',
  month: 'month',
  weekday: 'weekday',
}

const PREVIEW_RUNS = 3

/** What the schedule says and when it next runs, or why it cannot be read. */
export function readSchedule(
  cron: string,
  timezone: string,
  now: number,
): { ok: true; words: string; next: string[] } | { ok: false; message: string; field?: string } {
  const parsed = parseCronSchedule(cron)
  if (!parsed.ok) return { ok: false, message: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }
  const runs = nextScheduledAgentRuns({ cron, timezone }, now, PREVIEW_RUNS)
  if (runs.length === 0) return { ok: false, message: 'That schedule never comes round — no calendar has that day.' }
  return { ok: true, words: describeCronSchedule(parsed.schedule), next: formatRunTimes(runs, timezone, now) }
}

/**
 * The schedule, as one row in the composer's tray: what it says, when it next
 * runs, and Change, which opens the picker over it. The prompt box stays the
 * prompt's alone — nothing about when is typed into what.
 */
export function ScheduleTray({
  cron,
  timezone,
  onChange,
  failure,
  onDismissFailure,
}: {
  cron: string
  timezone: string
  onChange: (cron: string) => void
  /** Why the last run did not start, said until the person has seen it. */
  failure?: string | null
  onDismissFailure?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const read = readSchedule(cron, timezone, Date.now())
  return (
    <ComposerTray>
      {failure ? (
        <ComposerTrayRow tone="error" onDismiss={onDismissFailure}>
          The last run did not start: {failure}
        </ComposerTrayRow>
      ) : null}
      <ComposerTrayRow
        glyph={<ScheduleGlyph className="icon-sm text-[color:var(--accent-primary)]" />}
        ariaLabel="Schedule"
        actions={
          <Popover
            open={open}
            onOpenChange={setOpen}
            ariaLabel="Schedule"
            popupRole="dialog"
            placement="bottom-end"
            surfaceClassName="w-[380px] p-3"
            renderTrigger={({ ref, triggerProps, togglePopover }) => (
              <GhostButton ref={ref} size="xs" pressed={open} onClick={togglePopover} {...triggerProps}>
                Change
              </GhostButton>
            )}
          >
            <ScheduleEditor cron={cron} timezone={timezone} onChange={onChange} />
          </Popover>
        }
      >
        {read.ok ? (
          <>
            <span className="font-medium">{read.words}</span>
            <span className="text-meta text-[color:var(--text-subtle)]"> · next {read.next[0]}</span>
          </>
        ) : (
          <span className="text-[color:var(--tone-error)]">{read.message}</span>
        )}
      </ComposerTrayRow>
    </ComposerTray>
  )
}

/**
 * The picker. Daily, Weekly and Monthly write the everyday shapes; Cron takes
 * anything. Every change that reads is handed back at once, so the tray row
 * above says the new schedule while the picker is still open; one that does
 * not read is kept here, marked, and the last schedule that did stays.
 */
export function ScheduleEditor({
  cron,
  timezone,
  onChange,
}: {
  cron: string
  timezone: string
  onChange: (cron: string) => void
}) {
  const [state, setState] = React.useState<ScheduleEditorState>(() => editorStateFromCron(cron))
  const update = (next: ScheduleEditorState) => {
    setState(next)
    const written = cronFromEditorState(next)
    if (written && parseCronSchedule(written).ok) onChange(written)
  }
  const written = cronFromEditorState(state) ?? ''
  const read = readSchedule(written, timezone, Date.now())

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        ariaLabel="How often"
        size="sm"
        items={TABS}
        value={state.tab}
        onChange={(tab) => update(switchTab(state, tab))}
        className="w-full [&>*]:flex-1 [&>*]:justify-center"
      />

      {state.tab === 'weekly' ? (
        <ScheduleSection label="On">
          <div className="grid grid-cols-7 gap-1" role="group" aria-label="Days of the week">
            {WEEKDAYS.map((day) => {
              const on = state.weekdays.includes(day.value)
              return (
                <ChipButton
                  key={day.value}
                  variant="outline"
                  pressed={on}
                  aria-label={day.name}
                  onClick={() =>
                    update({
                      ...state,
                      weekdays: on
                        ? state.weekdays.filter((value) => value !== day.value)
                        : [...state.weekdays, day.value],
                    })
                  }
                  className="h-control-sm justify-center"
                >
                  {day.short}
                </ChipButton>
              )
            })}
          </div>
        </ScheduleSection>
      ) : null}

      {state.tab === 'monthly' ? (
        <ScheduleSection label="On day">
          <div className="grid grid-cols-7 gap-1" role="group" aria-label="Days of the month">
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
              const on = state.monthDays.includes(day)
              return (
                <ChipButton
                  key={day}
                  variant="outline"
                  pressed={on}
                  onClick={() =>
                    update({
                      ...state,
                      monthDays: on ? state.monthDays.filter((value) => value !== day) : [...state.monthDays, day],
                    })
                  }
                  className="justify-center tabular-nums"
                >
                  {day}
                </ChipButton>
              )
            })}
          </div>
        </ScheduleSection>
      ) : null}

      {state.tab === 'cron' ? (
        <CronField
          text={state.cronText}
          badField={read.ok ? null : ((read as { field?: string }).field ?? null)}
          onChange={(cronText) => update({ ...state, cronText })}
        />
      ) : (
        <ScheduleSection label="At">
          <div className="flex flex-wrap items-center gap-1.5">
            {state.times.map((time, index) => (
              <TimeField
                key={`${index}-${time}`}
                time={time}
                removable={state.times.length > 1}
                onChange={(next) =>
                  update({ ...state, times: state.times.map((value, at) => (at === index ? next : value)) })
                }
                onRemove={() => update({ ...state, times: state.times.filter((_, at) => at !== index) })}
              />
            ))}
            <ChipButton
              variant="outline"
              onClick={() => update({ ...state, times: [...state.times, nextFreeTime(state.times)] })}
              className="h-control-sm"
            >
              + Time
            </ChipButton>
          </div>
        </ScheduleSection>
      )}

      <div
        className="rounded-md bg-[color:var(--bg-surface)] px-3 py-2"
        role="status"
        aria-live="polite"
        aria-label="What this schedule does"
      >
        {read.ok ? (
          <>
            <p className="text-heading font-medium text-[color:var(--text-strong)]">{read.words}</p>
            <p className="mt-0.5 text-meta tabular-nums text-[color:var(--text-subtle)]">
              Next {read.next.join(' · ')}
            </p>
          </>
        ) : (
          <>
            <p className="text-body text-[color:var(--tone-error)]">{read.message}</p>
            <p className="mt-0.5 text-meta text-[color:var(--text-subtle)]">
              The last schedule that read stays until this one does.
            </p>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 text-meta text-[color:var(--text-subtle)]">
        <ScheduleGlyph className="icon-xs shrink-0" />
        <span className="min-w-0 flex-1 truncate">Your time · {timezone}</span>
        {state.tab !== 'cron' && written ? (
          <code className="rounded-xs bg-[color:var(--bg-surface)] px-1 font-mono text-micro text-[color:var(--text-muted)]">
            {written}
          </code>
        ) : null}
      </div>
    </div>
  )
}

function ScheduleSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-meta font-medium text-[color:var(--text-subtle)]">{label}</p>
      {children}
    </div>
  )
}

// A time the list does not have yet: an hour after the last one, wrapping at
// midnight, so "+ Time" never adds a duplicate a person then has to fix.
function nextFreeTime(times: ScheduleTime[]): ScheduleTime {
  let candidate = ((times[times.length - 1] ?? 8 * 60) + 60) % (24 * 60)
  while (times.includes(candidate)) candidate = (candidate + 60) % (24 * 60)
  return candidate
}

/**
 * One time of day, typed: "9", "9:30", "9pm", "21:00". Read on Enter or when
 * focus leaves; one that does not read goes back to what it was. A bare hour
 * keeps the AM/PM the field already had.
 */
function TimeField({
  time,
  removable,
  onChange,
  onRemove,
}: {
  time: ScheduleTime
  removable: boolean
  onChange: (time: ScheduleTime) => void
  onRemove: () => void
}) {
  const shown = formatScheduleTime(time)
  const [text, setText] = React.useState(`${shown.clock} ${shown.meridiem}`)
  React.useEffect(() => setText(`${shown.clock} ${shown.meridiem}`), [shown.clock, shown.meridiem])
  const commit = () => {
    const read = parseScheduleTime(text, shown.meridiem)
    if (read === null) setText(`${shown.clock} ${shown.meridiem}`)
    else if (read !== time) onChange(read)
  }
  return (
    <span className="inline-flex items-center">
      <Input
        size="sm"
        fullWidth={false}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        aria-label="Time of day"
        className="w-[10ch] tabular-nums"
      />
      {removable ? (
        <CloseIconButton size="xs" aria-label={`Remove ${shown.clock} ${shown.meridiem}`} onClick={onRemove} />
      ) : null}
    </span>
  )
}

function CronField({
  text,
  badField,
  onChange,
}: {
  text: string
  badField: string | null
  onChange: (text: string) => void
}) {
  return (
    <div>
      <Input
        size="md"
        value={text}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label="Cron schedule"
        aria-invalid={badField !== null || undefined}
        spellCheck={false}
        autoFocus
        placeholder="0 9 * * 1-5"
        className="font-mono tracking-[0.04em]"
      />
      {/* The five fields named under the line, the wrong one in the error ink —
          which part to fix, not just that something is wrong. */}
      <div className="mt-1 grid grid-cols-5 px-3 text-micro text-[color:var(--text-subtle)]" aria-hidden="true">
        {CRON_FIELD_NAMES.map((field) => (
          <span key={field} className={badField === field ? 'text-[color:var(--tone-error)]' : undefined}>
            {FIELD_LABEL[field]}
          </span>
        ))}
      </div>
    </div>
  )
}
