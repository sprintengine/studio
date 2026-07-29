// The Horizon door's detail pane (MC-1923, mockup v2 frame 1) — the right-hand
// pane showing the selected step.
//
// A Horizon step IS a backlog item, so this mounts the very same
// `BacklogItemDetailPane` the Backlog door mounts. The children roll-up, the
// mockups, the dependencies, the body and the epic⇄child navigation all come
// free and can never drift from Backlog.
//
// What Horizon ADDS is one band directly under the title: the run that is
// delivering this step — agents, tasks left, the branch, the pull request, and
// the steering the step's state earns. That is the only thing on this surface
// Backlog cannot know. Beneath it, for a MULTI-REPO run, the pull-request
// surface with its merge-order blockers, because one "Approve & merge" cannot
// express which repo has to land first.
//
// The v1 "In this horizon" key/value block (track · step N of M · starts next)
// is deliberately NOT built: every one of those facts is already visible in the
// plan column 400px to the left.

import { useMemo } from 'react'

import { GhostButton, LifecycleGlyph, PrimaryButton, Spinner, TruncatedText } from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { BacklogItemDetailPane } from '../../backlog/BacklogItemDetailPane'
import { RoadmapPullRequests } from './RoadmapPullRequests'
import { useLaneRun } from './roadmapBoardData'
import type { HorizonStepRow } from './horizonPlanModel'
import { backlogItemSlugFromPath, type BacklogItem } from '../../../utils/backlog'
import { epicSlug, groupItemsByEpic } from '../../../utils/backlogEpics'
import type { BacklogLinkProvider } from '../../../modules/renderer-host'
import type { BacklogActions, BacklogDependencyChoice, BacklogEpicChoice } from '../../backlog/BacklogItemContextMenu'
import type { BacklogProjectFeed, BacklogProjectRef } from '../../../hooks/useAllProjectsBacklog'

/** The live run delivering the selected step, or null when nothing is running
 *  on it. Resolved by the door from the track that holds the step. */
export type HorizonStepRun = {
  /** The run-state file — the projection this pane reads. */
  statePath: string
  /** The track the run belongs to, for the steering commands. */
  lane: string
  /** What the track is waiting on, if anything. */
  attention: 'none' | 'approval' | 'merge' | 'paused'
  /** A command for this track is in flight. */
  busy: boolean
}

/** A step resolved to the backlog item behind it, in its own project's feed. */
export type ResolvedStepItem = {
  item: BacklogItem
  project: BacklogProjectRef
  feed: BacklogProjectFeed
}

/** Why a step has no item behind it. Three genuinely different problems with
 *  three different fixes, so the pane must never collapse them into one blank. */
export type HorizonStepUnresolved =
  // Its project is not open in this Multicode (or its alias maps nowhere).
  | 'project_unavailable'
  // That project's backlog scan has not reported yet.
  | 'loading'
  // The scan reported and the file is not in it.
  | 'missing'

export type HorizonDetailPaneProps = {
  /** The selected step, or null when nothing is selected. */
  step: HorizonStepRow | null
  resolved: ResolvedStepItem | null
  /** Why `resolved` is null; ignored when it is not. */
  unresolved: HorizonStepUnresolved
  run: HorizonStepRun | null
  /** A workspace is mounted on the run's own state file, so "Open sprint" can
   *  actually land. An autonomous run may have none — the affordance is then not
   *  offered at all, rather than being a control that quietly does nothing. */
  canOpenRun: boolean
  /** Where the home project lives, for the pull-request surface's merges. */
  homePath: string | null
  now: number
  actions: BacklogActions
  linkProviders: ReadonlyArray<BacklogLinkProvider>
  epicChoices: BacklogEpicChoice[]
  dependencyChoices: BacklogDependencyChoice[]
  onNavigate: (itemId: string) => void
  onReload: () => void
  onPause: (lane: string) => void
  onResume: (lane: string) => void
  onApprove: (lane: string) => void
  onMerge: (lane: string) => void
  /** Focus the running sprint's own workspace, when it is open. */
  onOpenRun: (statePath: string) => void
  /** What this pane says with nothing selected. A DRAFT horizon says what a
   *  draft is here (MC-1925) rather than growing a second layout for it. */
  emptySelection?: { title: string; body: string }
}

export function HorizonDetailPane(props: HorizonDetailPaneProps): JSX.Element {
  const { step, resolved, unresolved, run } = props

  if (!step) {
    return (
      <DetailMessage
        title={props.emptySelection?.title ?? 'Nothing selected'}
        body={props.emptySelection?.body ?? 'Pick a step on the left to see the work it delivers.'}
      />
    )
  }
  if (!resolved) {
    // A project this Multicode cannot reach, a scan still running, and a file
    // that is genuinely gone are three different problems with three different
    // fixes. Collapsing them into one blank pane is the defect.
    if (unresolved === 'loading') {
      return (
        <div className="flex h-full w-full items-center justify-center gap-2 text-[12px] text-[color:var(--text-muted)]">
          <Spinner size={14} />
          Loading this step…
        </div>
      )
    }
    if (unresolved === 'project_unavailable' || step.state === 'unknown_project') {
      return (
        <DetailMessage
          title={`${step.projectName} isn’t open in this Multicode`}
          body="This step changes a project the horizon names but this Multicode can’t resolve. Open that project, or re-map the alias in the horizon file’s projects: block."
          detail={step.ref}
        />
      )
    }
    return (
      <DetailMessage
        title="This step’s backlog item is missing"
        body="The horizon still lines it up, so the track parks here rather than skipping it. Remove the step, or restore the file."
        detail={step.ref}
      />
    )
  }

  return (
    <BacklogItemDetailPane
      item={resolved.item}
      project={resolved.project}
      feed={resolved.feed}
      // A Horizon step's live state comes from the TRACK (the run strip below),
      // not from a per-workspace runner lookup, so the shared pane's own glyph
      // resolution stays empty here rather than guessing at one.
      resolveRunGlyph={() => undefined}
      now={props.now}
      actions={props.actions}
      linkProviders={props.linkProviders}
      epicChoices={props.epicChoices}
      dependencyChoices={props.dependencyChoices}
      showBack={false}
      onBack={() => undefined}
      onNavigate={props.onNavigate}
      headerExtra={
        run ? (
          <HorizonRunStrip
            run={run}
            canOpenRun={props.canOpenRun}
            homePath={props.homePath}
            onReload={props.onReload}
            onPause={props.onPause}
            onResume={props.onResume}
            onApprove={props.onApprove}
            onMerge={props.onMerge}
            onOpenRun={props.onOpenRun}
          />
        ) : undefined
      }
    />
  )
}

// ── the run strip ────────────────────────────────────────────────────────────

/** What the strip says about a run, derived from its own projection — never a
 *  claim the projection cannot support. Pure, so the wording is testable. */
export function runStripFacts(input: {
  agentsWorking: number
  tasksLeft: number
  loading: boolean
  /** The projection could not be read — zero tasks means UNKNOWN, not done. */
  failed?: boolean
  attention: HorizonStepRun['attention']
  pullRequestUrl?: string | null
  pullRequestState?: string | null
}): string[] {
  const facts: string[] = []
  if (input.agentsWorking > 0) {
    facts.push(`${input.agentsWorking} ${input.agentsWorking === 1 ? 'agent' : 'agents'}`)
  }
  if (input.tasksLeft > 0) {
    facts.push(`${input.tasksLeft} ${input.tasksLeft === 1 ? 'task' : 'tasks'} left`)
  } else if (!input.loading && !input.failed) {
    // Zero tasks left is only 'delivered' when we actually READ the run. A failed
    // projection read also reports zero, and announcing 'delivered' above the
    // words "couldn't read this sprint's progress" is the worst kind of wrong.
    facts.push('delivered')
  }
  if (input.pullRequestUrl) {
    const number = /\/pull\/(\d+)/.exec(input.pullRequestUrl)?.[1]
    const label = number ? `PR #${number}` : 'Pull request'
    const state =
      input.pullRequestState === 'merged'
        ? 'merged'
        : input.pullRequestState === 'closed'
          ? 'closed'
          : input.attention === 'merge'
            ? 'waiting on you'
            : 'open'
    facts.push(`${label} ${state}`)
  }
  return facts
}

// The loudest thing in the pane: what is happening to this step right now, and
// the one steering action its state earns.
function HorizonRunStrip({
  run,
  canOpenRun,
  homePath,
  onReload,
  onPause,
  onResume,
  onApprove,
  onMerge,
  onOpenRun,
}: {
  run: HorizonStepRun
  canOpenRun: boolean
  homePath: string | null
  onReload: () => void
  onPause: (lane: string) => void
  onResume: (lane: string) => void
  onApprove: (lane: string) => void
  onMerge: (lane: string) => void
  onOpenRun: (statePath: string) => void
}): JSX.Element {
  const { vcs, blockers, agentsWorking, tasksLeft, loading, error, reload } = useLaneRun(run.statePath)
  const repos = vcs?.repos ?? []
  const pullRequest = repos.find((repo) => repo.pullRequestUrl) ?? null
  const primaryRepo = repos[0] ?? null

  const facts = runStripFacts({
    agentsWorking,
    tasksLeft,
    loading,
    failed: Boolean(error),
    attention: run.attention,
    pullRequestUrl: pullRequest?.pullRequestUrl ?? vcs?.pullRequestUrl ?? null,
    pullRequestState: pullRequest?.pullRequestState ?? vcs?.pullRequestState ?? null,
  })

  // Only genuinely live work animates: a parked track and a run waiting on a
  // human merge are both stopped, whatever the strip is showing.
  const live = run.attention === 'none' && agentsWorking > 0

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[5px] border border-[color:var(--accent-primary-soft-strong)] bg-[color:var(--accent-primary-soft)] px-2.5 py-2">
      <div className="flex items-center gap-2.5">
        <LifecycleGlyph
          state={run.attention === 'paused' ? 'paused' : run.attention === 'none' ? 'in_progress' : 'ready'}
          live={live}
          className="shrink-0 text-[color:var(--accent-primary)]"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[12px] tabular-nums text-[color:var(--text-strong)]">
            {facts.length > 0 ? facts.join(' · ') : 'Working…'}
          </span>
          {primaryRepo?.branchName ? (
            <TruncatedText
              as="span"
              text={`${primaryRepo.branchName}${primaryRepo.baseRef ? ` → ${primaryRepo.baseRef}` : ''}`}
              className="min-w-0 font-mono text-[10px] text-[color:var(--text-subtle)]"
            />
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {/* The pull request, as a LINK. The strip names it either way, but a
              single-repo run gets no `RoadmapPullRequests` below (there is no
              merge order to express), so without this the common case reads
              a waiting pull request as dead text with no way to reach it. */}
          {pullRequest?.pullRequestUrl ?? vcs?.pullRequestUrl ? (
            <a
              href={(pullRequest?.pullRequestUrl ?? vcs?.pullRequestUrl) as string}
              target="_blank"
              rel="noreferrer"
              className={`interactive inline-flex h-6 shrink-0 items-center rounded-[5px] px-2 text-[11px] font-medium text-[color:var(--accent-primary)] hover:underline ${FOCUS_RING_CLASS}`}
            >
              View PR
            </a>
          ) : null}
          {canOpenRun ? (
            <GhostButton size="xs" onClick={() => onOpenRun(run.statePath)}>
              Open sprint
            </GhostButton>
          ) : null}
          {run.attention === 'merge' ? (
            <PrimaryButton size="xs" disabled={run.busy} onClick={() => onMerge(run.lane)}>
              Approve &amp; merge
            </PrimaryButton>
          ) : run.attention === 'approval' ? (
            <PrimaryButton size="xs" disabled={run.busy} onClick={() => onApprove(run.lane)}>
              Start next
            </PrimaryButton>
          ) : run.attention === 'paused' ? (
            <PrimaryButton size="xs" disabled={run.busy} onClick={() => onResume(run.lane)}>
              Resume
            </PrimaryButton>
          ) : (
            <GhostButton size="xs" disabled={run.busy} onClick={() => onPause(run.lane)}>
              Pause
            </GhostButton>
          )}
        </span>
      </div>
      {/* A read failure must not blank the strip that carries the steering — it
          says so quietly and keeps the controls. */}
      {error ? (
        <p role="status" className="text-[10px] leading-4 text-[color:var(--tone-warn)]">
          Couldn’t read this sprint’s progress. {error}
        </p>
      ) : null}
      {/* The pull-request surface, for a run whose repos need a merge ORDER. One
          repo needs no ordering, so the common case never pays for it. */}
      {vcs && repos.length > 1 ? (
        <div className="border-t border-[color:var(--accent-primary-soft-strong)] pt-1">
          <RoadmapPullRequests
            vcs={vcs}
            blockers={blockers}
            statePath={run.statePath}
            folderPath={homePath}
            onMerged={() => {
              reload()
              onReload()
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

// ── honest empty/failure states ──────────────────────────────────────────────

function DetailMessage({ title, body, detail }: { title: string; body: string; detail?: string }): JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      <h3 className="text-[13px] font-semibold text-[color:var(--text-strong)]">{title}</h3>
      <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">{body}</p>
      {detail ? (
        <p className="max-w-[46ch] break-all font-mono text-[10px] text-[color:var(--text-subtle)]">{detail}</p>
      ) : null}
    </div>
  )
}

// ── resolving a step to a backlog item ───────────────────────────────────────

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
}

/** Resolve a step's project + relative path to the feed item behind it. A step
 *  carries the project it lives in, so this is a path match INSIDE that
 *  project's feed — two projects can hold the same relative path, so matching
 *  across all feeds would pick the wrong item. */
export function resolveStepItem(
  feeds: ReadonlyArray<BacklogProjectFeed>,
  projectRoot: string | null,
  relativePath: string,
): ResolvedStepItem | null {
  if (!projectRoot) return null
  const wanted = normalizePath(relativePath)
  const rootKey = normalizePath(projectRoot)
  for (const feed of feeds) {
    if (normalizePath(feed.root) !== rootKey) continue
    for (const entry of feed.items) {
      if (normalizePath(entry.item.relativePath) === wanted) {
        return { item: entry.item, project: entry.project, feed }
      }
    }
  }
  return null
}

/** The choice sets the shared detail's menus need, derived the same way the
 *  Backlog door derives them — through the shared helpers, so the two doors
 *  cannot offer different epics for the same project. An epic or a prerequisite
 *  never crosses a project, so both come from the step's OWN feed. */
export function useHorizonDetailChoices(feed: BacklogProjectFeed | null): {
  epicChoices: BacklogEpicChoice[]
  dependencyChoices: BacklogDependencyChoice[]
} {
  const epicChoices = useMemo<BacklogEpicChoice[]>(
    () =>
      feed
        ? groupItemsByEpic(feed.items.map((entry) => entry.item))
            .filter((group) => group.kind === 'epic' && group.slug != null)
            .map((group) => ({ slug: group.slug as string, title: group.title, displayId: group.epic?.displayId }))
        : [],
    [feed],
  )

  const dependencyChoices = useMemo<BacklogDependencyChoice[]>(
    () =>
      feed
        ? feed.items
            .map((entry) => entry.item)
            .filter((item) => !item.isEpic)
            .map((item) => ({
              id: item.id,
              slug: backlogItemSlugFromPath(item.relativePath),
              title: item.title,
              displayId: item.displayId,
            }))
        : [],
    [feed],
  )

  return { epicChoices, dependencyChoices }
}

// Re-exported so the door can name a step's epic without importing the util
// twice; `epicSlug` is the same function the Backlog door's rollups key on.
export { epicSlug }
