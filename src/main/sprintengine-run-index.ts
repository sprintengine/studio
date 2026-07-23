import { readFile, readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { pathExists } from './filesystem-workspace'
import { normalizeSprintEngineProjection } from '../shared/sprintengine/state'
import { describeUnsupportedSprintEngineStore } from '../shared/sprintengine/store-schema'
import { deriveSprintRunSummary, type SprintRunSummary } from '../shared/sprintengine/runSummary'

// The main-process index answering "what sprint runs exist in this Multicode —
// live AND historical — across every known project root", without a resident
// workspace object per run. Data source for the Sprints door rail (T3) and
// canvas (T4). The disk scan is promoted from mobile discovery (D1): mobile is
// now a consumer of the same `discoverSprintEngineRunStatePaths` below, so there
// is one scan/dedupe/sort implementation and the two surfaces cannot drift.
//
// Never parses store internals: a projection is read only through
// `normalizeSprintEngineProjection` (the renderer/mobile boundary rule), and
// completion / cancellation / landed are the shared predicates, reused via
// `deriveSprintRunSummary`. A missing or unreadable projection yields a visible
// `unknown`-state row with a reason, never a dropped row and never a crash.

export type DiscoveredSprintEngineStatePath = {
  statePath: string
  updatedAtMs: number
}

// Scan one project root for its `<root>/.multi-code/sprintengine/*/run.yaml`
// runs. A root with no sprint tree (or an unreadable one) contributes nothing.
async function discoverSprintEngineStatePaths(workspaceRoot: string): Promise<DiscoveredSprintEngineStatePath[]> {
  const sprintEngineRoot = join(workspaceRoot, '.multi-code', 'sprintengine')
  let entries
  try {
    entries = await readdir(sprintEngineRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const statePaths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const statePath = join(sprintEngineRoot, entry.name, 'run.yaml')
        if (!(await pathExists(statePath))) {
          return null
        }
        return {
          statePath,
          updatedAtMs: await readSprintEngineUpdatedAtMs(statePath, join(sprintEngineRoot, entry.name, 'projection.json')),
        }
      })
  )
  return statePaths.filter((statePath): statePath is DiscoveredSprintEngineStatePath => Boolean(statePath))
}

/**
 * Every run under every given project root, deduped by state path (the same run
 * reachable through two roots is kept once, at its newest observed mtime) and
 * sorted newest-first. The shared scan for both the desktop run index and the
 * mobile snapshot discovery. Given exactly the roots to scan — the caller owns
 * any default-root policy.
 */
export async function discoverSprintEngineRunStatePaths(
  workspaceRoots: string[],
): Promise<DiscoveredSprintEngineStatePath[]> {
  const statePathGroups = await Promise.all(workspaceRoots.map((root) => discoverSprintEngineStatePaths(root)))
  const discovered = new Map<string, DiscoveredSprintEngineStatePath>()
  for (const item of statePathGroups.flat()) {
    const existing = discovered.get(item.statePath)
    if (!existing || item.updatedAtMs > existing.updatedAtMs) {
      discovered.set(item.statePath, item)
    }
  }
  return [...discovered.values()].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs || left.statePath.localeCompare(right.statePath),
  )
}

async function readSprintEngineUpdatedAtMs(statePath: string, projectionPath: string): Promise<number> {
  const [projectionStats, stateStats] = await Promise.all([
    stat(projectionPath).catch(() => null),
    stat(statePath).catch(() => null),
  ])
  return projectionStats?.mtimeMs ?? stateStats?.mtimeMs ?? 0
}

// --- Run summaries ----------------------------------------------------------

// Per-statePath memo keyed on the projection file's mtime+size (the token-usage
// reader sets this precedent). The cheap stat runs on every list to compute the
// key; the expensive read → parse → normalize → derive is cached and only reruns
// when the projection is actually rewritten (or when a change notification
// invalidates the entry). `absent` is the key for a run whose projection has not
// been written yet, so a later write flips the key and forces a reread.
type SprintRunSummaryCacheEntry = { key: string; summary: SprintRunSummary }
const summaryCache = new Map<string, SprintRunSummaryCacheEntry>()

/** Drop a run's cached summary so the next read re-derives it from disk. */
export function invalidateSprintRunSummary(statePath: string): void {
  summaryCache.delete(statePath)
}

// `<root>/.multi-code/sprintengine/<team>/run.yaml` → its identity fields.
function resolveRunIdentity(statePath: string): {
  teamDirectory: string
  teamSlug: string
  projectRoot: string
  projectName: string
} {
  const teamDirectory = dirname(statePath)
  const sprintEngineRoot = dirname(teamDirectory)
  const projectRoot = dirname(dirname(sprintEngineRoot))
  return {
    teamDirectory,
    teamSlug: lastPathSegment(teamDirectory),
    projectRoot,
    projectName: lastPathSegment(projectRoot),
  }
}

// Project display name: last path segment, normalizing separators and a
// trailing slash — the same rule the renderer's rail applies, so main and the
// Sprints door name a project identically.
function lastPathSegment(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/u, '')
  const lastSlash = normalized.lastIndexOf('/')
  return (lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)) || normalized
}

/**
 * The compact summary for one run, memoized on the projection's mtime+size. A
 * missing / unreadable / non-JSON / unsupported-schema / malformed projection all
 * resolve to an `unknown`-state row carrying its reason — never a throw, never a
 * dropped row (Fallback Discipline).
 */
export async function readSprintRunSummary(statePath: string): Promise<SprintRunSummary> {
  const identity = resolveRunIdentity(statePath)
  const projectionPath = join(identity.teamDirectory, 'projection.json')

  const stats = await stat(projectionPath).catch(() => null)
  const cacheKey = stats ? `${stats.mtimeMs}:${stats.size}` : 'absent'
  const cached = summaryCache.get(statePath)
  if (cached && cached.key === cacheKey) return cached.summary

  const summary = await deriveSummaryFromDisk(statePath, projectionPath, identity, stats?.mtime ?? null)
  summaryCache.set(statePath, { key: cacheKey, summary })
  return summary
}

async function deriveSummaryFromDisk(
  statePath: string,
  projectionPath: string,
  identity: ReturnType<typeof resolveRunIdentity>,
  projectionMtime: Date | null,
): Promise<SprintRunSummary> {
  const base = {
    statePath,
    teamSlug: identity.teamSlug,
    projectRoot: identity.projectRoot,
    projectName: identity.projectName,
    updatedAtFallback: projectionMtime ? projectionMtime.toISOString() : null,
  }

  let raw: string
  try {
    raw = await readFile(projectionPath, 'utf8')
  } catch {
    return deriveSprintRunSummary({
      ...base,
      state: null,
      unknownReason: 'Run projection has not been written yet.',
    })
  }

  let projection: unknown
  try {
    projection = JSON.parse(raw)
  } catch {
    return deriveSprintRunSummary({ ...base, state: null, unknownReason: 'Run projection is not valid JSON.' })
  }

  const rejection = describeUnsupportedSprintEngineStore(projection, identity.teamDirectory)
  if (rejection) {
    return deriveSprintRunSummary({ ...base, state: null, unknownReason: rejection })
  }

  const state = normalizeSprintEngineProjection(projection, identity.teamSlug)
  if (!state) {
    return deriveSprintRunSummary({ ...base, state: null, unknownReason: 'Run projection is malformed.' })
  }

  return deriveSprintRunSummary({ ...base, state })
}

/**
 * Every run across the given project roots as a compact summary, newest-first.
 * The Sprints door's data source. Summaries are memoized per statePath; entries
 * for runs no longer discovered (team dir deleted) are pruned so the cache stays
 * bounded to existing runs.
 */
export async function listSprintRuns(workspaceRoots: string[]): Promise<SprintRunSummary[]> {
  const uniqueRoots = [...new Set(workspaceRoots)]
  const discovered = await discoverSprintEngineRunStatePaths(uniqueRoots)
  const summaries = await Promise.all(discovered.map((item) => readSprintRunSummary(item.statePath)))

  const live = new Set(discovered.map((item) => item.statePath))
  for (const statePath of summaryCache.keys()) {
    if (!live.has(statePath)) summaryCache.delete(statePath)
  }
  return summaries
}
