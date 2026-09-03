import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runRelativePathForStatePath } from '../../../shared/backlog/sprintengine-links'
import { TRACKER_RUN_SOURCE_FILENAME } from '../../../shared/sprintengine/workspace-creation'
import type { TrackerProviderId } from '../../../shared/tracker/types'
import type { RunIssue, RunIssueLookup } from './engine'

// Resolves which tracker issue a run was started from (MC-2359).
//
// This used to scan the backlog object store for a proxy item whose Sprint
// Engine execution link resolved to this run, then read the issue identity off
// that item's `external_*` frontmatter. Proxy items are gone, so the run carries
// its own reference instead: `startTrackerIssueSprint` writes
// `tracker-source.json` beside the run state, and this reads it back.
//
// That is strictly better than the scan it replaces — it is O(1) rather than a
// walk of every backlog item, and it cannot be confused by a second item linking
// the same run.

const PROVIDERS: ReadonlySet<string> = new Set<TrackerProviderId>(['github', 'jira', 'linear'])

// Injected so tests drive the lookup without a run on disk.
export type RunIssueLookupDeps = {
  readRunSource(statePath: string): Promise<string | null>
}

export function createRunIssueLookup(deps: RunIssueLookupDeps = defaultDeps()): RunIssueLookup {
  return {
    async issuesForRun({ workspaceRoot, statePath }): Promise<RunIssue[]> {
      const raw = await deps.readRunSource(statePath)
      if (!raw) return []

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // A corrupt sidecar means we do not know which issue this run is for.
        // Posting to a guess would be worse than posting nothing.
        return []
      }
      const identity = normalizeRunSource(parsed)
      if (!identity) return []

      // The notice metadata names the run, which is what a failure is now about
      // — there is no backlog item to point a reader at.
      const relativePath = runRelativePathForStatePath(workspaceRoot, statePath) ?? statePath
      return [{ relativePath, ...identity }]
    },
  }
}

function normalizeRunSource(value: unknown): Omit<RunIssue, 'relativePath'> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const connectionId = typeof record.connectionId === 'string' ? record.connectionId.trim() : ''
  const externalId = typeof record.externalId === 'string' ? record.externalId.trim() : ''
  if (!provider || !PROVIDERS.has(provider) || !connectionId || !externalId) return null
  const nativeKey = typeof record.nativeKey === 'string' ? record.nativeKey.trim() : ''
  return {
    provider: provider as TrackerProviderId,
    connectionId,
    externalId,
    nativeKey: nativeKey || externalId,
  }
}

function defaultDeps(): RunIssueLookupDeps {
  return {
    readRunSource: async (statePath) => {
      try {
        return await readFile(join(dirname(statePath), TRACKER_RUN_SOURCE_FILENAME), 'utf-8')
      } catch {
        // Absent is the common case: most runs are not started from a tracker.
        return null
      }
    },
  }
}
