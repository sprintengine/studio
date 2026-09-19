// The small pieces a sidebar row is built from: the shelf fold row, the
// attention pulse, row tooltips, the project line, the branch chip and the
// working timer.

import { RowButton, Tooltip, TruncatedText } from '../../ui'
import { useChangePulse } from '../../../hooks/useChangePulse'
import React, { createContext, useContext, useState, useEffect } from 'react'
import { shortMachineName } from '../../remote/machineRowModel'
import { RemoteMachineGlyph, FolderTypeIcon, GitBranchGlyph } from '../../AppIcons'
import { type ProjectColor } from '../../../utils/projectColor'
import { ProjectPullRequestMark } from '../PullRequestMark'
import { formatElapsedMs } from '../../../utils/relativeTime'

// A shelf's fold row (settled-chats, 2026-09-07): the one line a folder shows
// for a group of parked chats — its name, and how many — collapsed by default,
// in the fold-row idiom the older-rows disclosure used to carry. The section
// rule applies (design-system/components/section): a heading earns its place by
// separating one group from another, so the row renders only when the folder
// has rows to separate from its active ones.
//
// Two shelves use it — Settled (rest) and Snoozed (sleep, 2026-09-10). They are
// the same line with a different word, and one component is what keeps them
// reading as the same kind of thing.
export function ShelfFoldRow({
  label,
  count,
  expanded,
  controlsId,
  onToggle,
  flush = false,
}: {
  label: string
  count: number
  expanded: boolean
  controlsId: string
  onToggle: () => void
  /** The flat stream's shelf: no folder header above it, so no indent under one. */
  flush?: boolean
}) {
  return (
    <div className="mx-1.5 my-0.5 flex items-center gap-1">
      {/* The kit's nav row. Only the alignment inset stays with the caller —
          a `pl-*` out-specifies the density's `px-2` in Tailwind's own
          ordering — along with the type step, which `RowButton` deliberately
          does not spell. */}
      <RowButton
        density="nav"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={controlsId}
        // design-tokens-allow: alignment — 30px = the workspace row's 4px rail + 26px inset, so the fold row's text lines up under the row title (see the layout note in this file); flush drops to 10px, which is the same sum for a flat-stream row
        className={`min-w-0 flex-1 select-none ${flush ? 'pl-[10px]' : 'pl-[30px]'} pr-1.5 text-meta`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform ${
            expanded ? '' : '-rotate-90'
          }`}
        >
          <path
            d="M5 6L8 9L11 6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="truncate">{label}</span>
        <span className="tabular-nums text-[color:var(--text-subtle)]">{count}</span>
      </RowButton>
    </div>
  )
}

/**
 * The one-shot flash a row plays when it STARTS needing you (`warn`), or when
 * a turn on it has just finished while you were elsewhere (`good`).
 *
 * Motion here means "just changed" — the other of the two things this system
 * lets motion mean — and then it stops. What holds the row loud while it waits
 * is ink: the gold fill, rail and title. An ambient shimmer was considered and
 * ruled out (owner, 2026-09-04): `components/liveness` is explicit that motion
 * is not emphasis and that a mark which is always moving stops meaning
 * anything, and three waiting rows would have been three loops running beside
 * the terminals.
 *
 * It renders as a keyed, pointer-inert sibling rather than on the row itself,
 * so replaying the animation never remounts a row mid-drag or steals its focus.
 * `mode: 'increase'` fires on the way in only; `resetKey` keeps a row that
 * merely swaps identity from flashing.
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
}) {
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
 * How long the turn in flight has been running, beside the working dots (owner
 * direction 2026-09-04): the dots say work
 * is ongoing, this says for how long. The word is dropped — the dots already
 * carry it and the aria-label spells it out — because a 276px rail has no room
 * to repeat itself.
 *
 * It owns its own tick rather than riding the sidebar's shared `useRelativeNow`:
 * that runs at 30s and so cannot count seconds, and dropping IT to 1s would
 * re-render the whole tree once a second. Here one text node re-renders, and the
 * tick relaxes to 30s once the turn is past a minute and the seconds stop
 * mattering.
 */
// Two hover surfaces over one row is one too many (owner, 2026-09-09).
//
// A chat row already opens the conversation peek from a hover anywhere on it,
// and the card says what the row's own tooltips were saying: how much changed,
// how long it has been idle, what the agent is doing. Dwelling on the row while
// scrolling past it fired BOTH, and the tooltip — wider than the row and
// positioned over its neighbours — landed on top of the card that was arriving
// to answer the same question.
//
// So the row's readings carry `RowTooltip`, which is the kit's Tooltip
// everywhere except inside a row that opens a card, where it is the trigger's
// own wrapper and nothing else. This is the 2026-09-07 title ruling continued:
// where there IS a card, the card is the surface; where there is not, every one
// of these tooltips still opens exactly as it did.
//
// Not everything on the row is in here. A glyph whose ONLY meaning is its label
// — the machine mark, the provider mark, "Directory removed" — keeps the kit's
// Tooltip outright, because suppressing it would leave a drawing that says
// nothing and a card that never mentions it.
// Exported for `WorkspaceSidebar.rowTooltips.test.tsx`, as the row's other
// pieces are: the rule is one line of behaviour and it is tested directly.
export const RowTooltipsSuppressed = createContext(false)

export function RowTooltip({ children, ...props }: React.ComponentProps<typeof Tooltip>) {
  const suppressed = useContext(RowTooltipsSuppressed)
  if (!suppressed) return <Tooltip {...props}>{children}</Tooltip>
  // The same wrapper the kit renders, so suppressing a tooltip never moves the
  // thing it was wrapping: Tooltip's own span is `relative` plus the caller's
  // wrapperClassName, defaulting to `inline-flex`.
  return (
    <span role={props.wrapperRole} className={`relative ${props.wrapperClassName ?? 'inline-flex'}`}>
      {children}
    </span>
  )
}

/**
 * The one mark that says a row is running somewhere else: the machine glyph,
 * in the connected green, with the device's name on hover.
 *
 * Green, not the row's own ink (owner, 2026-09-11). A remote row is now an
 * ordinary row of an ordinary project — it has no band, no header and no
 * "Remote" label around it any more — so this glyph is the whole of what
 * distinguishes it, and a muted mark beside a muted project name was not a
 * distinction anyone could see. It reads the same as every other live-link
 * green in the app (the top bar's Remote glyph, a machine that answers).
 *
 * The NAME stays in the tooltip and the accessible name, never in the row's
 * own width: `mac-mini.example.ts.net` would take the row.
 */
export function RemoteRowGlyph({ machineName }: { machineName: string }) {
  const short = shortMachineName(machineName)
  return (
    <Tooltip content={`On ${short}`} placement="bottom" wrapperClassName="flex shrink-0 items-center">
      <span
        role="img"
        aria-label={`On ${short}`}
        className="flex shrink-0 items-center"
        data-remote-row-glyph={machineName}
      >
        <RemoteMachineGlyph className="icon-xs shrink-0 text-[color:var(--tone-good)]" />
      </span>
    </Tooltip>
  )
}

/**
 * The project a row belongs to, as the flat stream says it: the folder glyph
 * in the project's hue, the project's name, its open pull requests, and — when
 * the row is running on a paired machine — the green machine glyph immediately
 * right of the folder icon (owner, 2026-09-11).
 *
 * One component for local and remote rows both, so a remote chat in the All
 * chats list is the same row as every other one, differing by that single mark.
 */
export type FlatProjectLine = {
  name: string
  folderPath: string | null
  color: ProjectColor | null
  unfiled: boolean
  openPullRequests: number
}

export function ProjectLine({
  project,
  machineName = null,
  dim = false,
  children,
}: {
  project: FlatProjectLine
  /** The device this row runs on; null for a local row. */
  machineName?: string | null
  dim?: boolean
  /** The row's status seat, which rides this line's trailing edge. */
  children?: React.ReactNode
}) {
  return (
    <div
      className={`flex h-5 min-w-0 items-center gap-1.5 text-meta ${
        dim ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
      }`}
    >
      {/* THE glyph the project's colour lives on in the flat stream
          (one-colour-per-project, 2026-09-09). The name beside it stays
          in the row's own ink: the hue identifies the project, and a
          coloured word would be a second, louder saying of it. */}
      <FolderTypeIcon className="icon-xs shrink-0" color={project.color} unfiled={project.unfiled} />
      {machineName ? <RemoteRowGlyph machineName={machineName} /> : null}
      <span className="min-w-0 truncate">{project.name}</span>
      {/* The project's open pull requests, beside the project's name
          (owner, 2026-09-10). In the flat stream this line is the only
          place the project is named, so it is the only place the summary
          can hang — the tree puts the same mark on its folder header.
          It repeats down a project's rows exactly as the project's name
          and colour already do: the line is the row's filing, and this
          is part of what that filing says. */}
      <ProjectPullRequestMark openCount={project.openPullRequests} projectName={project.name} dim={dim} />
      {children}
    </div>
  )
}

export function WorkingElapsed({ since }: { since: number }) {
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
    // status token rather than a mark plus an unrelated number. No aria-label
    // on a generic span (ignored there — the row's own review): the number is
    // the visible text and an sr-only sentence says what it measures.
    <span className="tabular-nums text-[color:var(--accent-primary)]">
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">Working for {text}</span>
    </span>
  )
}

/**
 * The branch a row or a line sits on: the glyph, the name, and the path on
 * hover. Shared by a terminal's line and by a parked worktree row, so the two
 * are the same chip and not two drawings of one idea that drift apart.
 *
 * A worktree reads at full strength — it is a checkout of its own, not one it
 * shares — and says so in words too, since weight alone carries no meaning.
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
  /** The row is background: nothing on its meta line may outshine its title. */
  dim?: boolean
}) {
  return (
    <RowTooltip
      content={cwd ? (worktree ? `Worktree · ${cwd}` : cwd) : worktree ? 'A worktree of its own' : `On ${branch}`}
      wrapperClassName="flex min-w-[4ch] shrink-[3] items-center"
    >
      <span
        className={`flex min-w-0 items-center gap-1 font-mono text-micro ${
          // A worktree of the terminal's own reads at full strength: it is
          // this terminal's checkout, not a checkout it shares. Not on a
          // background row, though — full strength there is BRIGHTER than the
          // dimmed title above it, which reads as the branch being the point
          // of a chat nobody is using (owner, 2026-09-07). It inherits the
          // line's ink instead.
          worktree && !dim ? 'text-[color:var(--text-default)]' : ''
        }`}
      >
        <GitBranchGlyph className="icon-xs shrink-0" />
        <TruncatedText as="span" text={branch} className="min-w-0" />
        {worktree ? <span className="sr-only"> (worktree)</span> : null}
      </span>
    </RowTooltip>
  )
}
