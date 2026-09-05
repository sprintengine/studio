// Merge order: which projects a repo's pull request must wait for.
//
// The board's pull-request surface disables a Merge button and shows "Merges after
// <project>" while any producer project is unmerged. This mirrors the engine's own
// authority (`_repos_that_must_merge_first` / `cross_repo_merge_edges` in
// sprintengine_core/tool/shell.py): a repo merges AFTER every repo it transitively
// depends on through a cross-repo task dependency; a repo that delivered nothing
// (no PR and no commit on its branch) blocks nobody. The engine's `pr-merge`
// primitive is still the final authority — it re-refuses at merge time and returns
// its own `blockedBy` — but deriving the same order here lets the surface PRE-disable
// rather than only reacting to a refused click. Documented mirror, not an import,
// because that logic is Python; a contract note keeps the pair aligned.
//
// Lived in `roadmap-surface.ts` until Horizon retired (2026-09-05); the Sprints
// door and the run board's repo strip are its consumers, so it moved here rather
// than going with the plan surface. Node-free by construction (tsconfig.web-safe).

import type { SprintEngineTask, SprintEngineVcsRepo } from './run-types'

export type RepoMergeBlockers = {
  // Per repo id: the producer repo ids (unmerged) it must merge after, or [] when
  // it is free to merge. Absent keys mean "not blocked".
  blockedBy: Map<string, string[]>
}

// A repo's own merge state, as the surface reads it off `vcs.repos`.
type RepoMergeFacts = {
  id: string
  merged: boolean
  // Delivered something worth merging (has a PR or a commit on its branch).
  delivers: boolean
}

export function deriveRepoMergeBlockers(
  tasks: ReadonlyArray<Pick<SprintEngineTask, 'id' | 'repo' | 'dependsOn'>>,
  repos: ReadonlyArray<SprintEngineVcsRepo>,
): RepoMergeBlockers {
  const factsById = new Map<string, RepoMergeFacts>()
  for (const repo of repos) {
    factsById.set(repo.id, {
      id: repo.id,
      merged: repo.pullRequestState === 'merged',
      delivers: Boolean(repo.pullRequestUrl) || Boolean(repo.lastCommitSha),
    })
  }

  // Repo → repo edges: a task's repo consumes from its dependency's repo when they
  // differ (a cross-repo dependency). Producer must merge before consumer.
  const repoByTaskId = new Map<string, string>()
  for (const task of tasks) repoByTaskId.set(task.id, task.repo)
  const producersOf = new Map<string, Set<string>>() // consumer repo -> producer repos
  for (const task of tasks) {
    const consumerRepo = task.repo
    for (const depId of task.dependsOn) {
      const producerRepo = repoByTaskId.get(depId)
      if (!producerRepo || producerRepo === consumerRepo) continue
      const set = producersOf.get(consumerRepo) ?? new Set<string>()
      set.add(producerRepo)
      producersOf.set(consumerRepo, set)
    }
  }

  const blockedBy = new Map<string, string[]>()
  for (const repo of repos) {
    const facts = factsById.get(repo.id)
    if (!facts || facts.merged || !facts.delivers) continue
    const blockers = transitiveUnmergedProducers(repo.id, producersOf, factsById)
    if (blockers.length > 0) blockedBy.set(repo.id, blockers)
  }
  return { blockedBy }
}

// Every transitive producer of `repoId` that has delivered something and has not
// merged — the projects that must land first. Iterative BFS; a producer that
// delivered nothing is transparent (we recurse through it but never list it), so a
// no-op repo in the chain never blocks.
function transitiveUnmergedProducers(
  repoId: string,
  producersOf: ReadonlyMap<string, Set<string>>,
  factsById: ReadonlyMap<string, RepoMergeFacts>,
): string[] {
  const blockers: string[] = []
  const seen = new Set<string>([repoId])
  const queue = [...(producersOf.get(repoId) ?? [])]
  while (queue.length > 0) {
    const producer = queue.shift() as string
    if (seen.has(producer)) continue
    seen.add(producer)
    const facts = factsById.get(producer)
    if (facts?.delivers && !facts.merged && !blockers.includes(producer)) {
      blockers.push(producer)
    }
    for (const upstream of producersOf.get(producer) ?? []) {
      if (!seen.has(upstream)) queue.push(upstream)
    }
  }
  return blockers
}
