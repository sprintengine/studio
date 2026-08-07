import type {
  SprintEnginePullRequestState,
  SprintEngineVcs,
  SprintEngineVcsRepo,
} from './run-types'

// The Sprint Engine VCS seam: the projection-side normalization of a run's
// `vcs` block and the cross-repo merge rollup derived from it. Extracted from
// state.ts (which grew past 3,300 lines by accretion) so the multi-repo VCS
// logic has one home. state.ts re-exports the public surface, so every existing
// import site keeps resolving through state.ts unchanged.
//
// This module owns its own `optionalTrimmedString` (a one-line pure primitive)
// rather than importing state.ts's copy, so there is no import cycle with the
// module that re-exports these functions.
function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * How far a run's branches are through merging, counted across every repo it
 * declared (MC-1613). A run spanning projects delivers one branch per project,
 * so it is only merged when the last one lands — reading the flat
 * `vcs.pullRequestState` would call the whole run merged the moment the primary
 * project's pull request did, while a sibling's branch was still open.
 *
 * Null for a run with no branch to merge (no worktree), which is what separates
 * "Complete" from "Ready for review". A single-repo run reports `total: 1` and
 * rolls up to exactly what the flat field said.
 */
export type SprintEngineRepoMergeRollup = {
  /**
   * Repos with a branch to merge: every declared repo except surviving entries
   * that delivered nothing (no commit on the run branch, no pull request).
   */
  total: number
  /** Counted repos whose pull request has merged. */
  merged: number
  /** Counted repos still waiting to merge — `total - merged`. */
  unmerged: number
  /** True only when every counted repo's pull request has merged. */
  allMerged: boolean
}

export function deriveSprintEngineRepoMergeRollup(
  vcs: SprintEngineVcs | null | undefined,
): SprintEngineRepoMergeRollup | null {
  if (!vcs) return null
  // The projection normalizes `repos` to a non-empty list, but this also reads a
  // `vcs` restored from persisted workspace state, which can predate the list and
  // carry only the flat fields until the next projection lands. That block IS the
  // one repo such a run has, so it rolls up as a one-entry list rather than
  // reporting "no branch to merge" and downgrading the glyph to plain Complete.
  const survivors = Array.isArray(vcs.repos) && vcs.repos.length > 0
    ? vcs.repos
    : [{ pullRequestState: vcs.pullRequestState ?? null, lastCommitSha: vcs.lastCommitSha ?? null }]
  // A surviving entry with no commit on the run branch and no pull request has
  // no branch to merge. The engine already accounts for it that way — `vcs.pr`
  // skips it as `no_commits`, its PR state can never advance, and merge
  // ordering treats it as "in nobody's way" — and a canceled sibling task is
  // terminal (MC-1749), so a zero-commit leg is a routine end state. Counting
  // it as forever-unmerged would hold `allMerged` false for good, wedging
  // run-landed chaining and roadmap advancement on a run the engine considers
  // delivered.
  const mustMerge = survivors.filter(
    (repo) => repo.pullRequestState != null || optionalTrimmedString(repo.lastCommitSha ?? undefined) !== undefined,
  )
  // Declared repos the normalizer DROPPED (partially provisioned, hand-edited)
  // stay fail-closed: they cannot be inspected, so they keep reading unmerged
  // rather than letting `allMerged` flip true off the survivors alone.
  const dropped = Math.max(0, (vcs.declaredRepoCount ?? 0) - survivors.length)
  const total = mustMerge.length + dropped
  const merged = mustMerge.filter((repo) => repo.pullRequestState === 'merged').length
  // `total === 0` (a run that delivered nothing anywhere) stays fail-closed:
  // there is no landing to report, so it must not read as all-merged.
  return { total, merged, unmerged: total - merged, allMerged: total > 0 && merged === total }
}

/**
 * The completion label for a run whose branches have not all merged. A run in one
 * project says only "Ready for review" — there is no second project to count, and
 * a count there would be noise on every single-repo run. A run spanning projects
 * names how many are still out, because "Ready for review" alone hides that some
 * of its branches have already landed.
 */
export function sprintEngineAwaitingMergeLabel(rollup: SprintEngineRepoMergeRollup): string {
  if (rollup.total <= 1) return 'Ready for review'
  const noun = rollup.unmerged === 1 ? 'project' : 'projects'
  return `Ready for review · ${rollup.unmerged} ${noun} left to merge`
}

// Entry zero of `vcs.repos` is the primary repo: the workspace itself, hence `.`.
// Mirrors PRIMARY_REPO_ID / PRIMARY_REPO_ROOT in sprintengine_core/tool/shell.py.
const primaryRepoId = 'primary'
const primaryRepoRoot = '.'

function normalizeSprintEnginePullRequestState(value: unknown): SprintEnginePullRequestState {
  return value === 'open' || value === 'merged' || value === 'closed' ? value : null
}

function normalizeSprintEngineVcsRepo(input: unknown): SprintEngineVcsRepo | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const id = optionalTrimmedString(record.id)
  const root = optionalTrimmedString(record.root)
  const worktreePath = optionalTrimmedString(record.worktreePath)
  const branchName = optionalTrimmedString(record.branchName)
  // A repo the app cannot resolve a tree for is worse than no entry: its scope would
  // silently point at the wrong worktree. Drop it and keep the repos it can resolve.
  if (!id || !root || !worktreePath || !branchName) return undefined
  return {
    id,
    root,
    worktreePath,
    branchName,
    ...(optionalTrimmedString(record.baseRef) ? { baseRef: optionalTrimmedString(record.baseRef) } : {}),
    ...(optionalTrimmedString(record.status) ? { status: optionalTrimmedString(record.status) } : {}),
    lastCommitSha: typeof record.lastCommitSha === 'string' ? record.lastCommitSha : null,
    pullRequestUrl: typeof record.pullRequestUrl === 'string' ? record.pullRequestUrl : null,
    pullRequestError: typeof record.pullRequestError === 'string' ? record.pullRequestError : null,
    pullRequestState: normalizeSprintEnginePullRequestState(record.pullRequestState),
  }
}

/**
 * The run's declared repos, from either shape the store may carry. `repos` is
 * explicitly whitelisted here (and typed field-by-field) because sync drops what
 * this normalizer does not name — the `normalizeResponse` precedent — so an
 * unlisted field would vanish between the engine and the app.
 */
function normalizeSprintEngineVcsRepos(record: Record<string, unknown>, primary: SprintEngineVcsRepo): SprintEngineVcsRepo[] {
  const declared = Array.isArray(record.repos)
    ? record.repos.map(normalizeSprintEngineVcsRepo).filter((repo): repo is SprintEngineVcsRepo => Boolean(repo))
    : []
  // A run stored before `vcs.repos` existed (MC-1611) describes its one repo with
  // the flat fields; it reads back as the one-entry list it always semantically was.
  return declared.length > 0 ? declared : [primary]
}

// How many repos the store declared, before any incomplete entry is dropped —
// each object entry in `repos` is one declared leg (backlog 1722). The flat shape
// (no `repos` array) declares exactly its one primary repo, so the survivor count
// (always ≥ 1) is the floor when no array is present.
function countDeclaredSprintEngineRepos(record: Record<string, unknown>): number {
  if (!Array.isArray(record.repos)) return 0
  return record.repos.filter((entry) => Boolean(entry) && typeof entry === 'object').length
}

export function normalizeSprintEngineVcs(input: unknown): SprintEngineVcs | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (record.mode !== 'run_worktree') return undefined
  // The flat block IS the primary repo in the other shape: same key names, same
  // values, only `id`/`root` implied. Deriving entry zero from it means one field
  // mapping serves both shapes and they cannot drift apart as the entry grows.
  const primary = normalizeSprintEngineVcsRepo({ ...record, id: primaryRepoId, root: primaryRepoRoot })
  // No worktree path or branch: not a run this app can resolve a tree for.
  if (!primary) return undefined
  const repos = normalizeSprintEngineVcsRepos(record, primary)
  return {
    mode: 'run_worktree',
    // Only when on: an absent flag and `false` mean the same normal mode, and
    // omitting it keeps a per-sprint run's projection byte-identical to before
    // per-task isolation existed (MC-2136).
    ...(record.taskIsolation === true ? { taskIsolation: true } : {}),
    worktreePath: primary.worktreePath,
    branchName: primary.branchName,
    ...(primary.baseRef ? { baseRef: primary.baseRef } : {}),
    ...(primary.status ? { status: primary.status } : {}),
    pullRequestUrl: primary.pullRequestUrl ?? null,
    pullRequestError: primary.pullRequestError ?? null,
    pullRequestState: primary.pullRequestState ?? null,
    lastCommitSha: primary.lastCommitSha,
    repos,
    declaredRepoCount: Math.max(countDeclaredSprintEngineRepos(record), repos.length),
  }
}

// --- Merge-state watchability ------------------------------------------------
//
// A PR merges on GitHub, outside the app, long after the run finished. Whoever
// re-probes `vcs pr-status` needs one rule for "is this run's merge state still
// worth a probe", and it is the same rule for main's poller
// (`main/sprintengine-pr-merge-poller.ts`, the owner since MC-2155) and for the
// board surfaces that describe what the poller is doing. It lives here, beside
// the normalizer that fills the `repos` list it reads.

/**
 * One repo worth re-probing: it has a branch/PR and the PR is not already in a
 * terminal state. `open` is the live case; `null` with a URL is a PR whose state
 * is not yet known (just created). Merged/closed are terminal — the state is
 * already correct, nothing left to watch.
 */
export function isPullRequestWatchable(input: {
  hasVcs: boolean
  prState: SprintEnginePullRequestState
  hasPrUrl: boolean
}): boolean {
  const { hasVcs, prState, hasPrUrl } = input
  if (!hasVcs) return false
  if (prState === 'merged' || prState === 'closed') return false
  return prState === 'open' || ((prState === null || prState === undefined) && hasPrUrl)
}

/**
 * A run spanning projects has one pull request per project, each merging on its own
 * schedule (MC-1612). One probe covers the whole run — `vcs pr-status` refreshes
 * every project in one call — so the question here is only whether ANY project is
 * still worth probing. Watching the primary alone would stop polling the moment the
 * desktop PR merged, freezing every other project's state at whatever the last poll
 * happened to see. `vcs.repos` always carries the primary at entry zero, including
 * for runs stored before the list existed, so single-repo runs are unchanged.
 */
export function isRunPullRequestWatchable(vcs: SprintEngineVcs | null | undefined): boolean {
  if (!vcs) return false
  return (vcs.repos ?? []).some((repo) =>
    isPullRequestWatchable({
      hasVcs: true,
      prState: repo.pullRequestState ?? null,
      hasPrUrl: !!repo.pullRequestUrl,
    }),
  )
}
