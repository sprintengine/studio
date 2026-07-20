import { teamSlugFromStatePath } from '../../../shared/backlog/sprintengine-links'
import type { SprintEngineProjectionReadResult } from '../../../shared/electron-api'
import type { SprintEngineState, SprintEngineVcs } from '../../../shared/sprintengine/run-types'
import { isCanceledSprintEngineRun, isCompletedSprintEngineRun, normalizeSprintEngineProjection } from '../../../shared/sprintengine/state'
import { sprintEngineRunFingerprint } from '../../automations/triggers/sprint-engine-run-events'
import type { RunStateReader, RunWriteBackFacts } from './engine'

// The honesty adapter (plan §3.7). Reads a run's FRESH projection through the
// sanctioned front door, then judges lifecycle with the SAME canonical predicates
// the renderer and the automation triggers use — never a rendered/cached
// projection. This is the projection-freeze guard: `completed` is
// isCompletedSprintEngineRun on a freshly-read state, so a frozen UI projection
// can never make the engine post a completion that has not genuinely happened.
//
// The run INSTANCE id reuses `sprintEngineRunFingerprint` (the run-completed
// trigger's identity), so a delete-and-recreate of a team re-posts while task
// edits within one run keep one stable idempotency namespace.

// The projection read seam — the same `readProjection` the sprint runtime and
// automation triggers hold. Injected so the engine never reaches into run-store
// internals and tests drive it with a canned projection.
export type WriteBackProjectionReader = {
  readProjection(input: { statePath: string }): Promise<SprintEngineProjectionReadResult>
}

export function createRunStateReader(reader: WriteBackProjectionReader): RunStateReader {
  return {
    async readRunFacts({ statePath }): Promise<RunWriteBackFacts | null> {
      const team = teamSlugFromStatePath(statePath)
      if (!team) return null

      let read: SprintEngineProjectionReadResult
      try {
        read = await reader.readProjection({ statePath })
      } catch {
        return null // Unreadable ⇒ no facts ⇒ no posts.
      }
      if (!read.ok) return null

      const state = normalizeSprintEngineProjection(read.data, team)
      if (!state) return null

      const canceled = isCanceledSprintEngineRun(state)
      return {
        runId: `${team}:${sprintEngineRunFingerprint(state)}`,
        goal: state.goal,
        // A planned, executing run is the earliest honest "started" signal; a
        // just-created shell with no tasks yet has not started work.
        started: state.tasks.length > 0,
        // The projection-freeze guard: completion is judged from the run store,
        // and a canceled run is decided, not completed.
        completed: !canceled && isCompletedSprintEngineRun(state),
        canceled,
        pullRequestUrls: collectPullRequestUrls(state.vcs),
        taskCount: state.tasks.length,
      }
    },
  }
}

// Every delivered pull request URL across the run's projects, distinct, primary
// project first. Reads both the per-repo list and the flat primary fields so a
// run stored before the multi-repo list still surfaces its one PR.
function collectPullRequestUrls(vcs: SprintEngineState['vcs']): string[] {
  if (!vcs) return []
  const urls: string[] = []
  pushUrl(urls, vcs.pullRequestUrl)
  for (const repo of readRepos(vcs)) pushUrl(urls, repo.pullRequestUrl)
  return urls
}

function readRepos(vcs: SprintEngineVcs): SprintEngineVcs['repos'] {
  return Array.isArray(vcs.repos) ? vcs.repos : []
}

function pushUrl(urls: string[], candidate: string | null | undefined): void {
  const url = typeof candidate === 'string' ? candidate.trim() : ''
  if (url && !urls.includes(url)) urls.push(url)
}
