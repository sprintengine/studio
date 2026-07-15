import { readFile, readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { pathExists } from './filesystem-workspace'

// A run whose lifecycle has ended: nothing new will be worked, so it is dead
// weight on the phone beyond a short "recently finished" tail. The run-level
// status the engine writes to run.yaml / projection.json (recompute_phase in
// sprintengine_core/tool/tasks.py). Anything else — including planning/executing
// and an unreadable/unknown status — is treated as live and always kept.
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'archived', 'canceled'])

// How many of the most-recent terminal runs the unscoped snapshot keeps for the
// phone's "recently finished" affordance. Bounded and small: it sits below the
// size-shedding ladder, so a fleet of finished runs cannot crowd out the live ones.
const defaultTerminalRunKeepCount = 3

export async function discoverMobileSprintEngineStatePaths(workspaceRoots: string[]): Promise<string[]> {
  const roots = workspaceRoots.length > 0 ? workspaceRoots : [process.cwd()]
  const statePathGroups = await Promise.all(roots.map((root) => discoverSprintEngineStatePaths(root)))
  const discovered = new Map<string, DiscoveredSprintEngineStatePath>()
  for (const item of statePathGroups.flat()) {
    const existing = discovered.get(item.statePath)
    if (!existing || item.updatedAtMs > existing.updatedAtMs) {
      discovered.set(item.statePath, item)
    }
  }
  return [...discovered.values()]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.statePath.localeCompare(right.statePath))
    .map((item) => item.statePath)
}

type DiscoveredSprintEngineStatePath = {
  statePath: string
  updatedAtMs: number
}

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

// The default (unscoped) snapshot's sprint-engine set: every live run plus the
// most-recent terminal ones. Input order is preserved, so with the discovery's
// updatedAt-descending order the kept terminal runs are the newest few. Scoped
// requests (sprintEngineId / workspacePath) do NOT pass through here — they get
// their exact scope, terminal or not, so the phone can still open a finished run
// it names directly.
export async function filterToDefaultSnapshotStatePaths(
  statePaths: string[],
  keepTerminal: number = defaultTerminalRunKeepCount,
): Promise<string[]> {
  const terminalFlags = await Promise.all(statePaths.map(isTerminalRunStatePath))
  const kept: string[] = []
  let terminalKept = 0
  statePaths.forEach((statePath, index) => {
    if (!terminalFlags[index]) {
      kept.push(statePath)
      return
    }
    if (terminalKept < keepTerminal) {
      kept.push(statePath)
      terminalKept += 1
    }
  })
  return kept
}

async function isTerminalRunStatePath(statePath: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(join(dirname(statePath), 'projection.json'), 'utf8')
  } catch {
    // No projection yet (freshly created) or unreadable: treat as live and keep.
    return false
  }
  try {
    const projection = JSON.parse(raw) as { run?: { status?: unknown }; status?: unknown }
    const status = projection.run?.status ?? projection.status
    return typeof status === 'string' && TERMINAL_RUN_STATUSES.has(status)
  } catch {
    return false
  }
}

async function readSprintEngineUpdatedAtMs(statePath: string, projectionPath: string): Promise<number> {
  const [projectionStats, stateStats] = await Promise.all([
    stat(projectionPath).catch(() => null),
    stat(statePath).catch(() => null),
  ])
  return projectionStats?.mtimeMs ?? stateStats?.mtimeMs ?? 0
}
