// The pull-request surface for one lane's running sprint — the surface a roadmap
// user spends most of their attention on, so it is built first (owner priority
// 2026-07-15). One row per declared project: branch → base, its own merge state,
// and a Merge button right here. Merge ORDER is enforced visually: a project whose
// producer has not merged shows "Merges after <project>" with the button disabled
// until that is true. The engine's `pr-merge` primitive is still the final
// authority (it re-refuses and returns its own reason); this pre-disables from the
// proactively-derived order so the user never has to click to learn they must wait.
//
// It never invents CI/checks data — the engine collects none — so the truthful
// per-project status here is the PULL REQUEST lifecycle (open / merged / closed /
// none), rendered as the single status idiom (the 6px dot), not a fabricated check.

import React, { useCallback, useState } from 'react'

import { sprintEngineRepoDisplayName } from '../../../../../shared/backlog/sprintengine-links'
import type { SprintEnginePullRequestState, SprintEngineVcs, SprintEngineVcsRepo } from '../../../../../shared/sprintengine/run-types'
import type { RepoMergeBlockers } from '../../../../../shared/sprintengine/roadmap-surface'
import { useConfirmDialog } from '../../ui'

type MergePrState = 'merged' | 'closed' | 'open' | 'none'

function prStateOf(repo: SprintEngineVcsRepo): MergePrState {
  const state: SprintEnginePullRequestState = repo.pullRequestState ?? null
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'closed'
  if (repo.pullRequestUrl) return 'open'
  return 'none'
}

const PR_STATE_LABEL: Record<MergePrState, string> = {
  merged: 'Merged',
  closed: 'Closed',
  open: 'Open',
  none: 'No pull request',
}

// The one status dot's tone per PR state — merged is the product accent's calm
// "done", open is neutral-active, closed/none are muted. No competing pills.
const PR_STATE_DOT: Record<MergePrState, string> = {
  merged: 'var(--tone-good)',
  open: 'var(--accent-primary)',
  closed: 'var(--text-disabled)',
  none: 'var(--text-disabled)',
}

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
  const dialog = useConfirmDialog()
  const [merging, setMerging] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ repo: string; message: string } | null>(null)

  const nameOf = useCallback(
    (repo: Pick<SprintEngineVcsRepo, 'root'>) =>
      sprintEngineRepoDisplayName({ workspaceRoot: folderPath ?? '', root: repo.root }),
    [folderPath],
  )

  const handleMerge = useCallback(
    async (repo: SprintEngineVcsRepo) => {
      const name = nameOf(repo)
      const ok = await dialog.confirm({
        title: `Merge ${name}?`,
        body: `This merges the ${name} pull request. Merging is final — nothing merges on its own.`,
        confirmLabel: 'Merge',
      })
      if (!ok) return
      setMerging(repo.id)
      setRowError(null)
      try {
        const result = await window.api.mergeSprintEnginePullRequest(statePath, repo.id)
        if (!result.ok) {
          setRowError({ repo: repo.id, message: result.message })
          return
        }
        onMerged()
      } finally {
        setMerging(null)
      }
    },
    [dialog, nameOf, onMerged, statePath],
  )

  if (repos.length === 0) {
    return (
      <p className="px-3 py-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
        No pull requests yet. They appear here once this sprint opens one per project.
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col">
        {repos.map((repo) => {
          const state = prStateOf(repo)
          const blockedByIds = blockers.blockedBy.get(repo.id) ?? []
          const blockedByNames = blockedByIds.map((id) => {
            const producer = repos.find((candidate) => candidate.id === id)
            return producer ? nameOf(producer) : id
          })
          return (
            <li key={repo.id} className="border-t border-[color:var(--border-subtle)] first:border-t-0">
              <RoadmapPullRequestRow
                name={nameOf(repo)}
                repo={repo}
                state={state}
                blockedByNames={blockedByNames}
                merging={merging === repo.id}
                error={rowError?.repo === repo.id ? rowError.message : null}
                onMerge={() => void handleMerge(repo)}
              />
            </li>
          )
        })}
      </ul>
      <p className="px-3 pb-2 pt-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
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
  state: MergePrState
  blockedByNames: string[]
  merging: boolean
  error: string | null
  onMerge: () => void
}): JSX.Element {
  const blocked = blockedByNames.length > 0 && state !== 'merged'
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: PR_STATE_DOT[state] }}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--text-strong)]">
          {name}
        </span>
        <span className="shrink-0 text-[11px] text-[color:var(--text-muted)]">{PR_STATE_LABEL[state]}</span>
        <MergeControl
          repo={repo}
          state={state}
          blocked={blocked}
          blockedByNames={blockedByNames}
          merging={merging}
          onMerge={onMerge}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-3.5 text-[11px] text-[color:var(--text-subtle)]">
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
        <p className="pl-3.5 text-[11px] leading-4 text-[color:var(--text-muted)]">
          Merges after {formatProjectList(blockedByNames)}.
        </p>
      ) : null}
      {error ? (
        <p className="pl-3.5 text-[11px] leading-4 text-[color:var(--tone-warn)]">{error}</p>
      ) : null}
    </div>
  )
}

function MergeControl({
  repo,
  state,
  blocked,
  blockedByNames,
  merging,
  onMerge,
}: {
  repo: SprintEngineVcsRepo
  state: MergePrState
  blocked: boolean
  blockedByNames: string[]
  merging: boolean
  onMerge: () => void
}): JSX.Element | null {
  if (state === 'merged') {
    return <span className="shrink-0 text-[11px] font-medium text-[color:var(--tone-good)]">Merged</span>
  }
  if (state === 'none' || state === 'closed') {
    return null
  }
  if (blocked) {
    return (
      <button
        type="button"
        disabled
        aria-label={`Cannot merge yet — merges after ${blockedByNames.join(', ')}`}
        className="shrink-0 cursor-not-allowed rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-disabled)]"
      >
        Merges after {blockedByNames[0]}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onMerge}
      disabled={merging || !repo.pullRequestUrl}
      className="interactive shrink-0 rounded border border-[color:var(--accent-primary)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent-primary)] transition-colors hover:bg-[color:var(--accent-primary-soft)] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
    >
      {merging ? 'Merging…' : 'Merge'}
    </button>
  )
}

function formatProjectList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}
