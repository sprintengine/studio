import { useEffect, useMemo, useRef, useState } from 'react'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { useRelativeNow } from '../../../../hooks/useRelativeNow'
import { basename } from '../../../../utils/paths'
import { resolveDeclaredPath } from '../../../../utils/workspaceWorktree'
import { FolderTypeIcon } from '../../../AppIcons'
import { AgentWorkingDots, LifecycleGlyph, Tooltip } from '../../../ui'
import {
  AttentionPulse,
  BranchChip,
  DiffChip,
  RestingClock,
  WorkingElapsed,
} from '../../rowStatusParts'
import { useSidebarGitSummaries, type SummaryEntry } from '../../useSidebarGitSummaries'
import { SurfaceRail, type SurfaceRailRow, type SurfaceRailScope } from '../surfaceSubstrate'
import {
  buildSprintRailGroups,
  deriveSprintProjectChips,
  deriveSprintRunCompletions,
  sprintRunClock,
  sprintRunDetailWords,
  sprintRunEmphasis,
  sprintRunMatchesSearch,
  sprintRunProjectPhrase,
  SPRINT_SORT_ITEMS,
  type SprintRailRow,
  type SprintSort,
} from './railState'
import { RunDoorNewRow } from './RunDoorNewRow'
import { SPRINTS_DOOR, type RunDoorDefinition } from './runDoorCopy'

// Both run doors' rail (MC-1838, two doors since item 2470): the list IS the
// inbox. Runs group under "Needs you" (waiting on a person, honest since-dates),
// "Active" (genuinely live), and "Recent" (everything else) — there is no
// separate waiting strip pinned above the canvas. New leads the rail, then the project lens,
// then the search field with the sort axis behind the filter glyph — the
// Backlog door's toolbar order (MC-1816), so the project filter sits in the
// same place on both doors instead of leading the toolbar there and hiding
// behind a glyph here.
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20) — list
// semantics, ↑/↓ + j/k navigation, and row layout are the substrate's. Row
// building, grouping, filtering, and search matching are `railState`'s.
//
// One rail for both doors, parameterised by the door definition: every word that
// differs between Workflows and Sprints comes from `runDoorCopy`, and the runs
// have already been partitioned by the surface before they reach here. The
// door's one sentence sits at the top, under its name, and the `+` sits at the
// END of the list where the mockup puts it — the rail's New-at-top affordance
// stays where it has always been, so the Sprints door keeps everything it had.
//
// The rows are the app sidebar's rows (door-rails-premium): a project line with
// the run's clock in its corner — the working dots and how long a live run has
// been at it, or how long since a finished one landed — the run's name, and a
// line under it of the lifecycle mark, the run branch, what the branch has
// changed, and the leg that remains. A run that wants a person wears the gold
// wash and flashes once as it starts waiting; a run that finishes while this
// window is open wears the faint green wash until it is opened. Every part is
// the sidebar's own (`rowStatusParts`), so the two columns cannot drift.

const ALL_PROJECTS = ' all'

/**
 * The run in one sentence: the run, the lifecycle word its glyph draws, and the
 * state line. The rich row no longer wears it as a whole-row tooltip — its parts
 * each say their own piece, and a focused row's accessible name is those parts
 * in order — but it remains the sentence the rail's tests and the surface bar
 * read off a row, and stays a pure function for exactly that reason.
 */
export function sprintRowTooltip(row: SprintRailRow): string {
  return `${row.title} — ${row.glyph.label} · ${row.stateLine}`
}

/**
 * The runs whose completion this window has watched, and so may announce with
 * the green wash: a run goes in when it moves to `completed` under our eyes and
 * comes out the moment it is opened. Never persisted — reopening the app has
 * nothing to announce, the same rule the sidebar's unseen-done set follows.
 */
function useUnseenRunCompletions(
  runs: ReadonlyArray<SprintRunSummary>,
  selectedStatePath: string | null,
): ReadonlySet<string> {
  const previous = useRef<Map<string, SprintRunSummary['runtimeState']>>(new Map())
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const justCompleted = deriveSprintRunCompletions(previous.current, runs)
    previous.current = new Map(runs.map((summary) => [summary.statePath, summary.runtimeState]))
    setUnseen((current) => {
      // Kept to the runs that still exist: a deleted run's announcement goes
      // with it, so a new run created later at the same path never opens
      // wearing a wash it did not earn.
      const live = new Set(runs.map((summary) => summary.statePath))
      const next = new Set([...current].filter((statePath) => live.has(statePath)))
      for (const statePath of justCompleted) if (statePath !== selectedStatePath) next.add(statePath)
      return next.size === current.size && [...next].every((statePath) => current.has(statePath))
        ? current
        : next
    })
  }, [runs, selectedStatePath])
  useEffect(() => {
    if (selectedStatePath === null || !unseen.has(selectedStatePath)) return
    setUnseen((current) => {
      const next = new Set(current)
      next.delete(selectedStatePath)
      return next
    })
  }, [selectedStatePath, unseen])
  return unseen
}

/**
 * The checkout a run's ±lines are read from: its run worktree under its project
 * root, resolved the way every surface that opens a run worktree resolves it —
 * so the rail and the sidebar spell one tree one way, and main shares the git
 * read between them.
 */
function runCheckoutPath(summary: SprintRunSummary): string | null {
  return summary.worktreePath ? resolveDeclaredPath(summary.projectRoot, summary.worktreePath) : null
}

/**
 * What the ±lines chip may claim, from the reading's honesty contract
 * (`WorkspaceChangeSummary.scope`, main's workspace-change-summary): a run's
 * own worktree is the run's work; a shared checkout may carry a person's; a
 * folder reading — also what a failed branch read degrades to — is nobody's,
 * and steps back. The sidebar's three sentences, restated for a run.
 */
function diffChipCopy(
  scope: 'worktree' | 'branch' | 'folder',
  branch: string | null,
  noun: string,
  additions: number,
  deletions: number,
): { tooltip: string; srText: string; dim: boolean } {
  if (scope === 'worktree') {
    return {
      tooltip: `Changed by this ${noun} — it has its own worktree`,
      srText: `${additions} added, ${deletions} removed by this ${noun}`,
      dim: false,
    }
  }
  if (scope === 'branch') {
    return {
      tooltip: `Changed on ${branch ?? 'this branch'} — the checkout is shared, so a person or another terminal may have made some of it`,
      srText: `${additions} added, ${deletions} removed on ${branch ?? 'this branch'}`,
      dim: false,
    }
  }
  return {
    tooltip: 'Uncommitted changes in this folder — not attributable to this ' + noun,
    srText: `${additions} added, ${deletions} removed in this folder`,
    dim: true,
  }
}

/** A run whose branch is still being worked — the only ones worth asking git about. */
function isLiveRun(summary: SprintRunSummary): boolean {
  return summary.runtimeState === 'running' || summary.runtimeState === 'needs_input'
}

export function SprintsRail({
  door = SPRINTS_DOOR,
  runs,
  selectedStatePath,
  projectFilter,
  search,
  sort,
  onSelect,
  onFilter,
  onSearch,
  onSort,
  onCreate,
  now: nowOverride,
}: {
  /** Which door this rail is. Defaults to Sprints, the door that predates the
   *  split — so a caller that never heard of the other one still gets its copy. */
  door?: RunDoorDefinition
  runs: ReadonlyArray<SprintRunSummary>
  selectedStatePath: string | null
  /** Project root the rail is narrowed to, or null for every project. */
  projectFilter: string | null
  /** Search query over team/project names; empty for no narrowing. */
  search: string
  /** Row order within the groups — recency by default (the Backlog idiom). */
  sort: SprintSort
  onSelect: (statePath: string) => void
  onFilter: (projectRoot: string | null) => void
  onSearch: (query: string) => void
  onSort: (sort: SprintSort) => void
  onCreate: () => void
  /** The clock the resting rows read. Tests pin it, which also stops the
   *  shared 30-second tick; the app leaves it to that tick. A live run's
   *  working clock (`WorkingElapsed`) keeps its own second-hand and is never
   *  pinned — it is the one part of the rail that must actually move. */
  now?: number
}): JSX.Element {
  const tick = useRelativeNow(30_000, nowOverride === undefined)
  const now = nowOverride ?? tick
  const chips = deriveSprintProjectChips(runs)
  const unseenDone = useUnseenRunCompletions(runs, selectedStatePath)

  // What the run branch has changed, for the live runs only (owner ruling on
  // the sidebar, 2026-09-04, decision 9, applied here): a finished run's
  // worktree is often gone, and a parked one's ±lines would be the checkout's
  // present state rather than anything the run did. The poll is keyed by
  // checkout, so two runs on one tree share one read.
  const gitEntries = useMemo<SummaryEntry[]>(
    () =>
      runs
        .filter(isLiveRun)
        .map((summary) => ({ id: summary.statePath, checkoutPath: runCheckoutPath(summary) })),
    [runs],
  )
  const gitSummaries = useSidebarGitSummaries(gitEntries)

  const toRichRow = (row: SprintRailRow): SurfaceRailRow => {
    const { summary } = row
    const selected = row.id === selectedStatePath
    const clock = sprintRunClock(summary)
    const wantsYou = summary.runtimeState === 'needs_input'
    const finishedUnseen = !wantsYou && unseenDone.has(row.id)
    const emphasis = finishedUnseen ? 'active' : sprintRunEmphasis(summary, selected, now)
    const quiet = emphasis === 'quiet'
    const git = gitSummaries[row.id]
    const checkout = runCheckoutPath(summary)
    const diff = git ? diffChipCopy(git.scope, summary.branchName, door.noun, git.additions, git.deletions) : null
    return {
      id: row.id,
      title: row.title,
      stateLine: row.stateLine,
      emphasis,
      surface: wantsYou ? 'attention' : finishedUnseen ? 'done' : undefined,
      overlay: (
        <>
          <AttentionPulse active={wantsYou} resetKey={row.id} />
          <AttentionPulse active={finishedUnseen} resetKey={row.id} tone="good" />
        </>
      ),
      context: {
        icon: <FolderTypeIcon className="icon-xs shrink-0" />,
        label: sprintRunProjectPhrase(summary),
        seat: <RunClockSeat clock={clock} now={now} wantsYou={wantsYou} working={summary.runtimeState === 'running'} />,
      },
      detail: (
        <>
          <Tooltip content={row.glyph.label} placement="bottom" wrapperClassName="flex shrink-0 items-center">
            <LifecycleGlyph
              state={row.glyph.state}
              live={row.glyph.live}
              label={row.glyph.label}
              className={`shrink-0 ${quiet ? 'opacity-70' : ''}`}
            />
          </Tooltip>
          {summary.branchName ? (
            <BranchChip branch={summary.branchName} worktree={checkout !== null} cwd={checkout} dim={quiet} />
          ) : null}
          {git && diff ? (
            <DiffChip
              additions={git.additions}
              deletions={git.deletions}
              tooltip={diff.tooltip}
              srText={diff.srText}
              dim={diff.dim}
            />
          ) : null}
          <span className="min-w-0 truncate">{sprintRunDetailWords(summary)}</span>
        </>
      ),
    }
  }

  const searched = runs.filter((summary) => sprintRunMatchesSearch(summary, search))
  const rawGroups = buildSprintRailGroups(searched, projectFilter, sort)
  const groups = rawGroups.map((group) => ({ ...group, rows: group.rows.map(toRichRow) }))
  const rows = groups.flatMap((group) => group.rows)
  // A lens narrowed to a project whose last run has since been deleted: the
  // chips are derived from the runs, so that project is no longer among them.
  // Keep its option — the trigger must name the lens that is actually applied
  // (never the Select's placeholder), and it is the only way back to All
  // projects (the Backlog door's rule for a project it can no longer count).
  const strandedFilter =
    projectFilter && !chips.some((chip) => chip.projectRoot === projectFilter) ? projectFilter : null
  // The project lens, leading the rail exactly as it leads the Backlog toolbar.
  // Offered only when there is a second project to choose between — a lone
  // option beside "All projects" narrows nothing. Options carry their run count,
  // and `deriveSprintProjectChips` derives them from the runs themselves, so a
  // project with no run is never listed.
  const projectScope: SurfaceRailScope | undefined =
    chips.length > 1 || strandedFilter
      ? {
          ariaLabel: door.scopeAriaLabel,
          items: [
            { value: ALL_PROJECTS, label: `All projects · ${runs.length}` },
            ...chips.map((chip) => ({
              value: chip.projectRoot,
              label: `${chip.label} · ${chip.runCount}`,
            })),
            ...(strandedFilter
              ? [{ value: strandedFilter, label: `${basename(strandedFilter)} · no ${door.nounPlural}` }]
              : []),
          ],
          value: projectFilter ?? ALL_PROJECTS,
          onChange: (next: string) => onFilter(next === ALL_PROJECTS ? null : next),
        }
      : undefined
  // Sort is always offered (the Backlog idiom), and it is the only axis behind
  // the glyph now that the project lens leads the rail.
  const filterGroups = [
    {
      label: 'Sort',
      items: SPRINT_SORT_ITEMS.map((item) => ({ value: item.value as string, label: item.label })),
      value: sort as string,
      defaultValue: 'recent',
      onChange: (next: string) => onSort(next as SprintSort),
    },
  ]
  return (
    <SurfaceRail
      label={door.label}
      // The difference between the two doors, stated once, under the door's
      // name — and never again anywhere on the surface (item 2470).
      intro={door.tagline}
      rows={rows}
      groups={groups}
      selectedId={selectedStatePath}
      onSelect={onSelect}
      newAffordance={{ label: door.newLabel, onActivate: onCreate }}
      scope={projectScope}
      search={{
        value: search,
        onChange: onSearch,
        placeholder: door.search.placeholder,
        ariaLabel: door.search.ariaLabel,
      }}
      filter={{ ariaLabel: door.filterAriaLabel, groups: filterGroups }}
      // The lens is narrower than the runs behind it. Say so, rather than
      // letting an empty rail read as "you have none". The substrate
      // renders it under the head at the row inset; it used to be a sibling of
      // the rail, which put it at the bottom of the column (MC-2101).
      emptyNotice={
        runs.length > 0
          ? (search.trim() ? door.emptyRail.searched : door.emptyRail.scoped)
          : undefined
      }
      // The `+` at the end of the list, opening inline on the row where it was
      // (owner ruling R7). It rides `afterRows` because that is the slot INSIDE
      // the rail's one scrollport — a form beside the list would scroll
      // separately from the list it belongs to.
      //
      // Scoped to the LIST, not to the rows: the way to start a run does not
      // depend on what the search matched. Left at the default it vanished
      // whenever the empty notice showed — so a search for a run that does not
      // exist yet removed the one control that would create it, and an open form
      // with a half-typed goal in it was unmounted the moment the rows behind it
      // went to zero.
      afterRowsScope="list"
      afterRows={<RunDoorNewRow door={door} projectFilter={projectFilter} />}
    />
  )
}

/**
 * The clock in a run row's corner. Work in flight: the working dots and how
 * long, counting up from the run's start (the sidebar's "••• 14m"). Waiting on
 * a person: how long it has waited — no dot beside it, because the gold surface
 * is the mark and a dot beside it would say the same thing twice. At rest: how
 * long since it finished, was canceled, or was last touched, with the sentence
 * and the date on hover.
 */
function RunClockSeat({
  clock,
  now,
  wantsYou,
  working,
}: {
  clock: ReturnType<typeof sprintRunClock>
  now: number
  wantsYou: boolean
  /** The run is at work. The dots say so whether or not it has a start stamp
   *  to count from — a run without one shows the dots alone, as a sidebar
   *  turn without a timestamp does. */
  working: boolean
}): JSX.Element | null {
  if (working) {
    return (
      <>
        <AgentWorkingDots label="Agents working" />
        {clock?.kind === 'working' ? <WorkingElapsed since={clock.since} label="Running" /> : null}
      </>
    )
  }
  if (!clock) return null
  if (clock.kind === 'waiting') {
    return (
      <RestingClock
        at={clock.since}
        now={now}
        verb="Waiting on you"
        measure="for"
        className={`text-meta tabular-nums ${wantsYou ? 'text-[color:var(--tone-warn-on-tint)]' : ''}`}
      />
    )
  }
  if (clock.kind !== 'rested') return null
  return <RestingClock at={clock.at} now={now} verb={clock.verb} className="text-meta tabular-nums" />
}
