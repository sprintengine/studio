// The Sprints canvas leads with the multi-repo reality (item 1764, mockup §2):
// one card per repository the run declares — its name, its branch, its pull
// request, and its place in the merge order. A sprint that spans three projects
// has always worked that way; until now the UI buried it behind a single flat
// "pull request" field on the primary repo, so a run that had landed two of three
// branches read as simply "done".
//
// The PR vocabulary, the merge-order derivation, and the merge action are the
// shared `repoMergeSurface` module — the same ones the Roadmap lane's PR list
// renders (extracted, not rebuilt). This file owns only the card anatomy, and the
// engine's `pr-merge` stays the final authority for every merge.

import type { SprintEngineTask, SprintEngineVcsRepo } from '../../../../../../shared/sprintengine/run-types'
import type { RepoMergeBlockers } from '../../../../../../shared/sprintengine/roadmap-surface'
import { InlineNotice, StatusDot, TruncatedText } from '../../../ui'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import {
  formatProjectList,
  repoDisplayName,
  repoMergeBlockerNames,
  repoPullRequestNumber,
  repoPullRequestState,
  RepoMergeButton,
  type RepoMergeAction,
  REPO_PR_STATE_LABEL,
  REPO_PR_STATE_TONE,
  type RepoPullRequestState,
} from '../../../panels/sprintEngineBoard/repoMergeSurface'

export function SprintsRepoStrip({
  repos,
  tasks,
  blockers,
  projectRoot,
  merge,
}: {
  repos: ReadonlyArray<SprintEngineVcsRepo>
  tasks: ReadonlyArray<SprintEngineTask>
  blockers: RepoMergeBlockers
  /** The run's project root — resolves the primary repo's display name. */
  projectRoot: string
  /** The run's shared merge action (the bar's next-step button uses the same one),
   *  so a merge started anywhere reports back on the card it targeted. */
  merge: RepoMergeAction
}): JSX.Element {
  // Merge order only exists across repos. A single-repo run must never render a
  // "merges after" note or the "merge order enforced" qualifier — there is
  // nothing to order, and the qualifier would read as an unexplained warning.
  const multiRepo = repos.length > 1

  return (
    <section className="flex flex-col gap-2" aria-label="Repositories">
      {/* The heading is `ui/Section`'s (meta, semibold, strong ink) so the doors
          and the review canvas share one heading size and ink. Written here
          rather than through the component because this strip's cards sit on
          the canvas edge and `Section`'s own inset would step them in. */}
      <div className="flex items-baseline gap-1.5">
        <h3 className="text-meta font-semibold text-[color:var(--text-strong)]">Repositories</h3>
        {multiRepo ? (
          <span className="text-meta text-[color:var(--text-muted)]">merge order enforced</span>
        ) : null}
      </div>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
        {repos.map((repo, index) => {
          const name = repoDisplayName(repo, projectRoot)
          return (
            <li key={repo.id}>
              <RepoCard
                repo={repo}
                name={name}
                primary={index === 0}
                taskCount={tasks.filter((task) => task.repo === repo.id).length}
                blockedByNames={multiRepo ? repoMergeBlockerNames(repo, blockers, repos, projectRoot) : []}
                merging={merge.mergingRepoId === repo.id}
                error={merge.error?.repoId === repo.id ? merge.error.message : null}
                onMerge={() => void merge.merge(repo, name)}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function RepoCard({
  repo,
  name,
  primary,
  taskCount,
  blockedByNames,
  merging,
  error,
  onMerge,
}: {
  repo: SprintEngineVcsRepo
  name: string
  primary: boolean
  taskCount: number
  blockedByNames: string[]
  merging: boolean
  error: string | null
  onMerge: () => void
}): JSX.Element {
  const state = repoPullRequestState(repo)
  return (
    <div className="flex h-full flex-col gap-1.5 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <TruncatedText
          as="span"
          text={name}
          className="min-w-0 flex-1 text-meta font-medium text-[color:var(--text-strong)]"
        />
        {/* Entry zero is the repo that holds the run and its plan. A plain word
            in neutral ink, not a badge and not the accent — the card's one
            tinted idiom is its status dot, and the accent is the primary
            action's alone. */}
        {primary ? (
          <span className="shrink-0 text-micro font-medium text-[color:var(--text-muted)]">Primary</span>
        ) : null}
      </div>
      {/* The base ref reads in the line itself rather than behind a native
          tooltip a keyboard cannot reach; a clipped line reveals its full text. */}
      <div className="flex min-w-0 items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
        <BranchGlyph />
        <TruncatedText
          as="span"
          text={repo.baseRef ? `${repo.branchName} → ${repo.baseRef}` : repo.branchName}
          className="min-w-0 font-mono"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot tone={REPO_PR_STATE_TONE[state]} className="shrink-0" />
        <span className="text-micro text-[color:var(--text-muted)]">{pullRequestLine(repo, state)}</span>
        {repo.pullRequestUrl ? (
          <a
            href={repo.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            // A link is strong ink and an underline, never the accent — the
            // accent is spent on the one primary action in the view.
            className={`interactive shrink-0 rounded-xs text-micro text-[color:var(--text-strong)] underline ${FOCUS_RING_CLASS}`}
          >
            View
          </a>
        ) : null}
        <span className="ml-auto shrink-0 tabular-nums text-micro text-[color:var(--text-subtle)]">
          {taskCount === 1 ? '1 task' : `${taskCount} tasks`}
        </span>
        <RepoMergeButton
          repo={repo}
          state={state}
          blockedByNames={blockedByNames}
          merging={merging}
          onMerge={onMerge}
        />
      </div>
      {blockedByNames.length > 0 && state !== 'merged' ? (
        <p className="text-micro leading-4 text-[color:var(--text-subtle)]">
          Merges after {formatProjectList(blockedByNames)}.
        </p>
      ) : null}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    </div>
  )
}

// The pull request as one line: its number and lifecycle word when it can be
// identified, the lifecycle word alone when the URL is not a recognizable one, and
// plain words when there is none — never a fabricated number, never a bare "none".
function pullRequestLine(repo: SprintEngineVcsRepo, state: RepoPullRequestState): string {
  if (state === 'none') return 'No pull request yet'
  const number = repoPullRequestNumber(repo)
  return number === null ? REPO_PR_STATE_LABEL[state] : `PR #${number} · ${REPO_PR_STATE_LABEL[state]}`
}

function BranchGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-icon-xs shrink-0 text-[color:var(--text-disabled)]" aria-hidden="true">
      <path
        d="M5 3v7a3 3 0 0 0 3 3h3M5 3 3 5m2-2 2 2M11 13l2-2m-2 2-2-2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}
