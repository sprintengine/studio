// The pull-request surface for one lane's running sprint — the surface a roadmap
// user spends most of their attention on, so it is built first (owner priority
// 2026-07-15). One row per declared project: branch → base, its own merge state,
// and a Merge button right here.
//
// The PR-state vocabulary, the merge-order derivation, and the merge action itself
// live in the shared `repoMergeSurface` module (extracted from here for the Sprints
// door's repositories strip, MC-1764) so the two surfaces cannot drift on what
// "Open" means or on what merging does. This file owns only the row anatomy.

import React from 'react'

import type { SprintEngineVcs, SprintEngineVcsRepo } from '../../../../../shared/sprintengine/run-types'
import type { RepoMergeBlockers } from '../../../../../shared/sprintengine/roadmap-surface'
import { InlineNotice, StatusDot } from '../../ui'
import {
  formatProjectList,
  repoDisplayName,
  repoMergeBlockerNames,
  repoPullRequestState,
  useRepoMergeAction,
  RepoMergeButton,
  REPO_PR_STATE_LABEL,
  REPO_PR_STATE_TONE,
  type RepoPullRequestState,
} from '../sprintEngineBoard/repoMergeSurface'

export function RoadmapPullRequests({
  vcs,
  blockers,
  statePath,
  folderPath,
  onMerged,
}: {
  vcs: SprintEngineVcs | null
  blockers: RepoMergeBlockers
  statePath: string
  folderPath: string | null
  onMerged: () => void
}): JSX.Element {
  const repos = vcs?.repos ?? []
  const merge = useRepoMergeAction({ statePath, onMerged })

  if (repos.length === 0) {
    return (
      <p className="px-3 py-2 text-meta leading-5 text-[color:var(--text-muted)]">
        No pull requests yet. They appear here once this sprint opens one per project.
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col">
        {repos.map((repo) => {
          const state = repoPullRequestState(repo)
          const name = repoDisplayName(repo, folderPath)
          return (
            <li key={repo.id} className="border-t border-[color:var(--border-subtle)] first:border-t-0">
              <RoadmapPullRequestRow
                name={name}
                repo={repo}
                state={state}
                blockedByNames={repoMergeBlockerNames(repo, blockers, repos, folderPath)}
                merging={merge.mergingRepoId === repo.id}
                error={merge.error?.repoId === repo.id ? merge.error.message : null}
                onMerge={() => void merge.merge(repo, name)}
              />
            </li>
          )
        })}
      </ul>
      <p className="px-3 pb-2 pt-1.5 text-micro leading-4 text-[color:var(--text-subtle)]">
        Each project delivers on its own <span className="font-mono">sprintengine/…</span> branch from
        its own worktree. The working copy is removed after its pull request merges.
      </p>
    </div>
  )
}

function RoadmapPullRequestRow({
  name,
  repo,
  state,
  blockedByNames,
  merging,
  error,
  onMerge,
}: {
  name: string
  repo: SprintEngineVcsRepo
  state: RepoPullRequestState
  blockedByNames: string[]
  merging: boolean
  error: string | null
  onMerge: () => void
}): JSX.Element {
  const blocked = blockedByNames.length > 0
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={REPO_PR_STATE_TONE[state]} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-meta font-medium text-[color:var(--text-strong)]">
          {name}
        </span>
        <span className="shrink-0 text-micro text-[color:var(--text-muted)]">{REPO_PR_STATE_LABEL[state]}</span>
        {state === 'merged' ? (
          <span className="shrink-0 text-micro font-medium text-[color:var(--tone-merged)]">Merged</span>
        ) : (
          <RepoMergeButton
            repo={repo}
            state={state}
            blockedByNames={blockedByNames}
            merging={merging}
            onMerge={onMerge}
          />
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-3.5 text-micro text-[color:var(--text-subtle)]">
        <span className="truncate font-mono" title={repo.branchName}>
          {repo.branchName}
        </span>
        <span aria-hidden="true">→</span>
        <span className="truncate font-mono" title={repo.baseRef ?? 'base'}>
          {repo.baseRef ?? 'base'}
        </span>
        {repo.pullRequestUrl ? (
          <a
            href={repo.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="interactive ml-1 shrink-0 text-[color:var(--accent-primary)] hover:underline"
          >
            View
          </a>
        ) : null}
      </div>
      {blocked ? (
        <p className="pl-3.5 text-micro leading-4 text-[color:var(--text-muted)]">
          Merges after {formatProjectList(blockedByNames)}.
        </p>
      ) : null}
      {error ? (
        <div className="pl-3.5">
          <InlineNotice tone="error">{error}</InlineNotice>
        </div>
      ) : null}
    </div>
  )
}

