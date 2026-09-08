import { useEffect, useState } from 'react'

import { GitBranchGlyph } from '../AppIcons'
import { useChangePulse } from '../../hooks/useChangePulse'
import { formatElapsedMs, formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import { Tooltip } from '../ui/Tooltip'
import { TruncatedText } from '../ui/TruncatedText'

// The status vocabulary a list row speaks, as parts any list can compose
// (door-rails-premium): the working clock beside the dots, the one-shot flash a
// row plays when its state changes, the branch chip, the ±lines chip, and the
// clock a resting row wears. The app sidebar's workspace rows say all of these,
// and the Sprints and Workflows door rails now say them too — so a run row and
// a chat row read as one list, not two dialects of one idea.
//
// The sidebar (`WorkspaceSidebar.tsx`) still carries its own copies of the
// first three of these. That is deliberate for now, not an oversight: the
// sidebar file is mid-change on main (the flat all-chats stream), and lifting
// its copies out at the same moment would only manufacture a merge conflict on
// a 3,800-line file. Pointing the sidebar at this module is the follow-up
// recorded in the backlog item this change ships with — the classes and
// keyframes here are the SAME ones it uses (`.attention-row-pulse`,
// `.agent-working-dot`, `formatElapsedMs`), so the two cannot drift visually
// in the meantime.

/**
 * The selected row's edge, as a ring so it never moves the row. `--selection-edge`
 * rather than `--accent-primary` directly: the resting-tier rules in
 * assets/index.css rebind it to `transparent` on a pane that is not holding
 * focus, the same way they rebind the fill and the ink lift.
 */
export const SELECTION_EDGE_CLASS = 'ring-2 ring-inset ring-[color:var(--selection-edge)]'

/**
 * A row that wants a person: the gold wash, held on hover so hovering never
 * reads as the ask going away. The ink is the tone's on-tint mix so the title
 * stays legible on the wash. No dot beside it — the surface IS the mark.
 */
export function attentionRowSurfaceClass(selected: boolean): string {
  return [
    'bg-[color:var(--tone-warn-soft)] hover:bg-[color:var(--tone-warn-soft)]',
    selected ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-warn-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * A row that finished while nobody was looking: the faint green wash, which
 * lifts the moment the row is opened. A real turn end earns it, nothing else.
 */
export function doneRowSurfaceClass(selected: boolean): string {
  return [
    'bg-[color:var(--tone-good-faint)] hover:bg-[color:var(--tone-good-faint)]',
    selected ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-good-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * One-shot "this row has just changed state" flash — gold for a row that has
 * just started waiting on someone, green for one that has just finished. It
 * plays ONCE on arrival and then stops: the tinted fill is what keeps the row
 * loud while it waits, because motion is not emphasis and an ambient loop stops
 * meaning anything (design-system/components/liveness).
 *
 * Rendered as a keyed, pointer-inert sibling over the row rather than on the
 * row itself, so replaying it never remounts the row under the pointer.
 * `resetKey` is the row's identity: a list that recycles a slot for a different
 * row merely swaps identity from flashing.
 */
export function AttentionPulse({
  active,
  resetKey,
  tone = 'warn',
}: {
  active: boolean
  resetKey: string
  /** The status colour the row is already wearing; the flash never introduces its own. */
  tone?: 'warn' | 'good'
}): JSX.Element | null {
  const token = useChangePulse(active ? 1 : 0, { mode: 'increase', resetKey })
  if (token === 0) return null
  return (
    <span
      key={token}
      aria-hidden="true"
      className={`attention-row-pulse ${tone === 'good' ? 'attention-row-pulse-good' : ''} pointer-events-none absolute inset-0 rounded-md`}
    />
  )
}

/**
 * How long the work in flight has been running, beside the working dots: the
 * dots say work is ongoing, this says for how long. The word is dropped — the
 * dots already carry it and the sr-only sentence spells it out — because a
 * narrow rail has no room to repeat itself.
 *
 * It owns its own tick rather than riding a list's shared `useRelativeNow`:
 * that runs at 30s and so cannot count seconds, and dropping IT to 1s would
 * re-render the whole list once a second. Here one text node re-renders, and
 * the tick relaxes to 30s once the work is past a minute and the seconds stop
 * mattering. `label` names what is being timed for the screen reader.
 */
export function WorkingElapsed({ since, label = 'Working' }: { since: number; label?: string }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  const withinFirstMinute = now - since < 60_000
  useEffect(() => {
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), withinFirstMinute ? 1_000 : 30_000)
    return () => window.clearInterval(id)
  }, [since, withinFirstMinute])
  const text = formatElapsedMs(since, now)
  if (!text) return null
  return (
    // Accent ink, matching the dots it sits beside, so the pair reads as one
    // status token rather than a mark plus an unrelated number.
    <span className="tabular-nums text-[color:var(--accent-primary)]">
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">
        {label} for {text}
      </span>
    </span>
  )
}

/**
 * The clock a resting row wears: how long since it last did anything, as the
 * sidebar's "2h" — and, on hover, the sentence and the exact date. Nothing at
 * all under a minute, the sidebar's rule: a row that only just came to rest
 * needs no clock yet, and its wash or its mark already says what happened.
 *
 * `verb` is what the clock measures — "Finished", "Canceled", "Updated" — so
 * the tooltip and the sr text say what happened, not just when. `measure`
 * picks the sentence's shape: `ago` for a moment ("Finished 2h ago"), `for`
 * for a span still running ("Waiting on you for 2h").
 */
export function RestingClock({
  at,
  now,
  verb,
  measure = 'ago',
  className = 'text-meta tabular-nums',
}: {
  at: number
  now: number
  verb: string
  measure?: 'ago' | 'for'
  className?: string
}): JSX.Element | null {
  const short = formatRelativeMs(at, now)
  if (!short) return null
  const sentence = measure === 'for' ? `${verb} for ${short}` : `${verb} ${formatRelativeMsAgo(at, now)}`
  return (
    <Tooltip content={`${sentence} (${measure === 'for' ? 'since ' : ''}${new Date(at).toLocaleString()})`}>
      <span className={className}>
        <span aria-hidden="true">{short}</span>
        <span className="sr-only">{sentence}</span>
      </span>
    </Tooltip>
  )
}

/**
 * The branch a row sits on: the glyph, the name, and the path on hover. A
 * worktree of the row's own reads at full strength — it is this row's checkout,
 * not one it shares — and says so in words too, since weight alone carries no
 * meaning. `dim` is for a row that is background: nothing on its meta line may
 * outshine its title.
 */
export function BranchChip({
  branch,
  worktree,
  cwd,
  dim = false,
}: {
  branch: string
  worktree: boolean
  cwd: string | null
  dim?: boolean
}): JSX.Element {
  return (
    <Tooltip
      content={cwd ? (worktree ? `Worktree · ${cwd}` : cwd) : worktree ? 'A worktree of its own' : `On ${branch}`}
      wrapperClassName="flex min-w-[4ch] shrink-[3] items-center"
    >
      <span
        className={`flex min-w-0 items-center gap-1 font-mono text-micro ${
          worktree && !dim ? 'text-[color:var(--text-default)]' : ''
        }`}
      >
        <GitBranchGlyph className="icon-xs shrink-0" />
        <TruncatedText as="span" text={branch} className="min-w-0" />
        {worktree ? <span className="sr-only"> (worktree)</span> : null}
      </span>
    </Tooltip>
  )
}

/**
 * The ±lines a checkout carries, in the sidebar's exact shape: green added,
 * red removed (a true minus sign, never a hyphen), monospace and tabular so a
 * column of them lines up. Nothing when both are zero — a `+0 −0` is a chip
 * saying nothing. `tooltip` says whose changes they are; `srText` says the
 * same for the screen reader. `dim` is for a reading that is the folder's,
 * not the row's own (`scope: 'folder'`): the numbers are real, but nobody can
 * say the row made them, so they step back (the sidebar's `opacity-60`).
 */
export function DiffChip({
  additions,
  deletions,
  tooltip,
  srText,
  dim = false,
}: {
  additions: number
  deletions: number
  tooltip: string
  srText: string
  dim?: boolean
}): JSX.Element | null {
  if (additions <= 0 && deletions <= 0) return null
  return (
    <Tooltip content={tooltip} wrapperClassName="inline-flex shrink-0">
      <span className={`shrink-0 font-mono text-micro tabular-nums ${dim ? 'opacity-60' : ''}`}>
        <span className="text-[color:var(--tone-good)]">+{additions}</span>
        <span className="ml-1 text-[color:var(--tone-error)]">−{deletions}</span>
        <span className="sr-only">{srText}</span>
      </span>
    </Tooltip>
  )
}
