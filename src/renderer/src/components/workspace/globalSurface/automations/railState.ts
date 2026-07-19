import type { AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import type { Tone } from '../../../ui/tokens'
import { parseTime, relativeFromNow } from '../../../panels/AutomationsPanel/automationsFormat'

// The single, plain-language state line the Automations rail draws for each
// automation (mockup §3: "Ran 2h ago · passed", "Running now", "Paused",
// "Last run failed"). One dot idiom carries the tone. Pure over an instance
// index entry — no store, no IPC — so the rail never fans out a per-row call and
// the mapping is unit-testable.
//
// Priority is salience, not recency: a live run leads, then an unresolved
// failure (surfaced even on a paused automation so a failure is never hidden
// behind "Paused"), then the paused/blocked definition state, then the last
// successful run, then "never run". The tone drives the rail dot and is a
// StatusDot tone verbatim.
export type AutomationRailState = {
  text: string
  tone: Tone
  /** A run is executing right now — the dot pulses. */
  running: boolean
}

// completedAt ?? startedAt ?? dueAt, the same stamp the run rows display, so the
// "Ran 2h ago" time matches the run history the canvas shows.
function lastRunStamp(entry: AutomationsInstanceEntry): number | null {
  const run = entry.lastRun
  if (!run) return null
  return parseTime(run.completedAt) ?? parseTime(run.startedAt) ?? parseTime(run.dueAt)
}

export function automationRailState(entry: AutomationsInstanceEntry, now: number): AutomationRailState {
  if (entry.isRunningNow) return { text: 'Running now', tone: 'accent', running: true }

  const lastRun = entry.lastRun
  if (lastRun?.status === 'failed') return { text: 'Last run failed', tone: 'warn', running: false }
  if (lastRun?.status === 'blocked') return { text: 'Last run blocked', tone: 'warn', running: false }

  const status = entry.definition.status
  if (status === 'paused') return { text: 'Paused', tone: 'neutral', running: false }
  if (status === 'blocked') return { text: 'Blocked', tone: 'warn', running: false }

  if (!lastRun) return { text: 'Never run', tone: 'neutral', running: false }
  if (lastRun.status === 'skipped') return { text: 'Last run skipped', tone: 'neutral', running: false }

  const stamp = lastRunStamp(entry)
  const when = stamp !== null ? relativeFromNow(stamp, now) : 'recently'
  return { text: `Ran ${when} · passed`, tone: 'good', running: false }
}

// Plain-language degraded-state copy (quality-audit rule: never a raw error or
// blank pane). Pure + exported so the exact wording is locked by tests.

// Shown when the automations engine/scheduler is unreachable — scheduled runs
// are paused, but manual "Run now" still works, so the surface stays usable.
export const SCHEDULER_OFF_NOTICE =
  'The automation scheduler is not running, so scheduled runs are paused. Automations you run now still execute.'

// Shown when one or more project stores could not be read (instance index
// `problems`): the readable automations are still listed, the unreadable ones
// are named as omitted rather than silently dropped.
export function enumerationProblemsNotice(count: number): string {
  return count === 1
    ? 'One project’s automations could not be read and are not listed. The rest are shown.'
    : `${count} projects’ automations could not be read and are not listed. The rest are shown.`
}

// Folder basename of a project root — the label that names which project an
// automation belongs to, in the rail sub-lines and the surface bar. Trailing
// separators trimmed; a bare root falls back to the whole value.
export function projectLabel(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/u, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}
