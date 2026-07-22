// The run-store schema version this build understands, and the guard that
// rejects an out-of-date store. Extracted from the main-process
// `sprintengine-artifacts.ts` (which imports child_process and Electron-bound
// services) into this node-free leaf so every store reader — the main artifact
// path AND the disk-scanning run index — shares one source of truth and can be
// unit-tested without an Electron runtime. `sprintengine-artifacts.ts`
// re-exports both symbols, so its existing importers are unchanged.

// MIRRORS `RUN_SCHEMA_VERSION` in sprintengine_core/store.py. v2 (MC-1542,
// single-owner tasks) deleted quality gates and the
// `changes_requested`/`testing`/`product` statuses; v3 (MC-1591, leases replace
// the roster) removed the persistent `agents` map from run.yaml; v4 (MC-1611,
// multi-repo runs) made `vcs.repos` the run's declared repo list.
export const SPRINT_ENGINE_RUN_SCHEMA_VERSION = 4

/**
 * Reject an out-of-date run store, returning a readable message (or null when the
 * store is current).
 *
 * Decision 8 is a pre-release clean break: old stores are local runtime state and
 * are never migrated. The one requirement is that the rejection is LOUD at every
 * surface that reads a store. The renderer reads `projection.json` straight off
 * disk without going through Python, so this guard — not the Python loader — is
 * what stops the board, wizard, backlog links, run index, and module mount from
 * silently rendering gate-era data.
 *
 * A projection carrying a `run` object with no `schemaVersion` predates the field
 * and is therefore version 1. A payload with no `run` object at all is not a
 * projection; that is malformed input, judged downstream by
 * `normalizeSprintEngineProjection`, and this guard stays silent rather than
 * blaming it on an old Multicode.
 */
export function describeUnsupportedSprintEngineStore(projection: unknown, teamDirectory: string): string | null {
  if (!projection || typeof projection !== 'object') return null
  const run = (projection as { run?: unknown }).run
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null
  const rawVersion = (run as { schemaVersion?: unknown }).schemaVersion
  const version = typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : 1
  if (version >= SPRINT_ENGINE_RUN_SCHEMA_VERSION) return null
  return (
    `This sprint was created by an older version of Multicode (run store v${version}, ` +
    `this build reads v${SPRINT_ENGINE_RUN_SCHEMA_VERSION}). Sprints can now span more ` +
    `than one project (and before that, leases replaced the roster and single-owner ` +
    `tasks replaced quality gates), so the run cannot be opened. Delete ` +
    `"${teamDirectory}" and start the sprint again.`
  )
}
