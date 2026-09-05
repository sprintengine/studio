// The per-repo pull-request model shared by every surface that renders a run's
// declared repositories: the Roadmap lane's PR list (`RoadmapPullRequests`) and
// the Sprints door's repositories strip (`SprintsRepoStrip`). Extracted from the
// Roadmap surface, which owned it first — the two draw different anatomy (a row
// list vs. a card strip) but must never disagree about what "Open" means, which
// tone a merged branch carries, or what merging actually does.
//
// It never invents CI/checks data — the engine collects none — so the truthful
// per-repo status is the PULL REQUEST lifecycle (open / merged / closed / none).
// Merge order is enforced visually: a repo whose producer has not merged is
// pre-disabled with "Merges after <project>", derived from `deriveRepoMergeBlockers`.
// The engine's `pr-merge` primitive stays the final authority (it re-refuses and
// returns its own reason); pre-disabling only saves the user a click to learn it.

import React, { useCallback, useState } from 'react'

import { parsePullRequestUrl } from '../../../../../shared/review/pr-url'
import type { SprintEnginePullRequestState, SprintEngineVcsRepo } from '../../../../../shared/sprintengine/run-types'
import type { RepoMergeBlockers } from '../../../../../shared/sprintengine/repo-merge-blockers'
import { sprintEngineRepoDisplayName } from '../../../../../shared/backlog/sprintengine-links'
import { OutlineButton, useConfirmDialog } from '../../ui'
import type { StatusTone } from '../../ui/tokens'

export type RepoPullRequestState = 'merged' | 'closed' | 'open' | 'none'

export function repoPullRequestState(repo: SprintEngineVcsRepo): RepoPullRequestState {
  const state: SprintEnginePullRequestState = repo.pullRequestState ?? null
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'closed'
  if (repo.pullRequestUrl) return 'open'
  return 'none'
}

export const REPO_PR_STATE_LABEL: Record<RepoPullRequestState, string> = {
  merged: 'Merged',
  closed: 'Closed',
  open: 'Open',
  none: 'No pull request',
}

// The one status dot's tone per PR state (the shared StatusDot vocabulary, no
// competing pills). Merged is the app-wide merged purple — the same tone the rest
// of the app uses for a landed PR, never the "good" green a live-but-open PR would
// read as. Open is the product accent; closed/none are muted neutral.
export const REPO_PR_STATE_TONE: Record<RepoPullRequestState, StatusTone> = {
  merged: 'merged',
  open: 'accent',
  closed: 'neutral',
  none: 'neutral',
}

// The pull request's number, read from its recorded URL by the shared PR-URL
// parser — never a second regex. Null when the repo has no pull request, or when
// the URL is not a recognizable one, so the caller shows the state on its own.
export function repoPullRequestNumber(repo: SprintEngineVcsRepo): number | null {
  const url = repo.pullRequestUrl
  if (!url) return null
  const parsed = parsePullRequestUrl(url)
  return parsed && 'number' in parsed ? parsed.number : null
}

// The display name for a repo entry: the primary (`root: '.'`) reads as the
// project folder, a sibling as its own folder.
export function repoDisplayName(repo: Pick<SprintEngineVcsRepo, 'root'>, projectRoot: string | null): string {
  return sprintEngineRepoDisplayName({ workspaceRoot: projectRoot ?? '', root: repo.root })
}

// The projects that must land before this one, by display name. Empty for a repo
// that is already merged or has nothing in its way — so a single-repo run never
// renders a degenerate merge-order note.
export function repoMergeBlockerNames(
  repo: SprintEngineVcsRepo,
  blockers: RepoMergeBlockers,
  repos: ReadonlyArray<SprintEngineVcsRepo>,
  projectRoot: string | null,
): string[] {
  if (repoPullRequestState(repo) === 'merged') return []
  return (blockers.blockedBy.get(repo.id) ?? []).map((id) => {
    const producer = repos.find((candidate) => candidate.id === id)
    return producer ? repoDisplayName(producer, projectRoot) : id
  })
}

// True when merging this repo is possible right now: it has an open pull request
// and nothing it depends on is still out.
export function repoIsMergeable(
  repo: SprintEngineVcsRepo,
  blockers: RepoMergeBlockers,
): boolean {
  return (
    repoPullRequestState(repo) === 'open'
    && Boolean(repo.pullRequestUrl)
    && (blockers.blockedBy.get(repo.id) ?? []).length === 0
  )
}

export function formatProjectList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

export type RepoMergeAction = {
  /** Confirm, then merge THIS repo's pull request through the engine. */
  merge: (repo: SprintEngineVcsRepo, name: string) => Promise<void>
  /** Repo id whose merge is in flight, or null. */
  mergingRepoId: string | null
  /** The engine's refusal/failure for a repo, surfaced beside that repo. */
  error: { repoId: string; message: string } | null
  clearError: () => void
}

// The merge action itself: one confirm, one `pr-merge` call, one place the
// engine's refusal is captured. Shared so the Roadmap list and the Sprints strip
// cannot drift on the confirm copy or on treating a failure as a success.
export function useRepoMergeAction({
  statePath,
  onMerged,
}: {
  statePath: string
  onMerged: () => void
}): RepoMergeAction {
  const dialog = useConfirmDialog()
  const [mergingRepoId, setMergingRepoId] = useState<string | null>(null)
  const [error, setError] = useState<{ repoId: string; message: string } | null>(null)

  const merge = useCallback(
    async (repo: SprintEngineVcsRepo, name: string) => {
      const ok = await dialog.confirm({
        title: `Merge ${name}?`,
        body: `This merges the ${name} pull request. Merging is final — nothing merges on its own.`,
        confirmLabel: 'Merge',
      })
      if (!ok) return
      setMergingRepoId(repo.id)
      setError(null)
      try {
        const result = await window.api.mergeSprintEnginePullRequest(statePath, repo.id)
        if (!result.ok) {
          setError({ repoId: repo.id, message: result.message })
          return
        }
        onMerged()
      } finally {
        setMergingRepoId(null)
      }
    },
    [dialog, onMerged, statePath],
  )

  return { merge, mergingRepoId, error, clearError: useCallback(() => setError(null), []) }
}

// The one merge affordance both surfaces render. Nothing for a repo with no live
// pull request (merged / closed / none) — those states are already carried by the
// row's or card's PR status, and a button there would be a dead control. A blocked
// repo keeps its button visible but disabled, naming the project it waits on, so
// the merge order is legible without clicking.
export function RepoMergeButton({
  repo,
  state,
  blockedByNames,
  merging,
  onMerge,
}: {
  repo: SprintEngineVcsRepo
  state: RepoPullRequestState
  blockedByNames: string[]
  merging: boolean
  onMerge: () => void
}): JSX.Element | null {
  if (state !== 'open') return null
  if (blockedByNames.length > 0) {
    return (
      <OutlineButton
        size="xs"
        disabled
        className="shrink-0"
        aria-label={`Cannot merge yet — merges after ${blockedByNames.join(', ')}`}
      >
        Merges after {blockedByNames[0]}
      </OutlineButton>
    )
  }
  return (
    <OutlineButton size="xs" onClick={onMerge} disabled={merging || !repo.pullRequestUrl} className="shrink-0">
      {merging ? 'Merging…' : 'Merge'}
    </OutlineButton>
  )
}
