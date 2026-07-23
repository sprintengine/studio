// The sprint wizard's project model (item 1765): which project holds the run,
// and which other projects it also works in.
//
// A sprint used to start inside a project — the wizard inherited whatever folder
// the workspace was already in. Started from the Sprints door there is no such
// folder, so the primary project becomes an explicit field, and the other repos
// the run will change are declared here instead of discovered mid-run through
// `sprintengine.vcs.request_repo` (which stays, for the ones nobody foresaw).
//
// Everything in this file is pure. Disk questions ("is that a git project?")
// are asked through the `SprintProjectProbe` port the caller supplies, so the
// validation rules are testable without a filesystem.

import { basename, samePath, trimPath } from '../../../utils/paths'
import { DEFAULT_SPRINTENGINE_TASK_REPO } from '../../../../../shared/sprintengine/run-types'
import { slugifySiblingProjectId } from './helpers'

/** A project the wizard can offer: a known project root and what to call it. */
export type SprintProjectOption = {
  folderPath: string
  displayName: string
}

/** One extra project the run declares at init: the engine's `{id, root}` plus its label. */
export type SprintDeclaredRepo = {
  /** Short handle every task targets. Never `primary` — that is this run's own project. */
  id: string
  /** The project's path, relative to the primary project when they share an ancestor. */
  root: string
  /** Absolute path, kept so the panel can re-validate and de-duplicate selections. */
  folderPath: string
  displayName: string
}

/** Disk questions the validation rules ask. Both answer false on any failure. */
export type SprintProjectProbe = {
  pathExists: (path: string) => Promise<boolean>
}

// Path math shared by the containment rules. Case-insensitive, because the
// folder paths these compare come from macOS and Windows pickers.
function pathKey(pathValue: string): string {
  return trimPath(pathValue).replace(/\\/g, '/').toLowerCase()
}

function isInside(inner: string, outer: string): boolean {
  const innerKey = pathKey(inner)
  const outerKey = pathKey(outer)
  return innerKey !== outerKey && innerKey.startsWith(`${outerKey}/`)
}

/**
 * The project the wizard opens on: the active workspace's project when there is
 * one, otherwise the most recently used project root. `recentFolders` is already
 * most-recent-first, so the first known root it names wins; a project root the
 * recents never mention still resolves (first known root) rather than leaving
 * the field empty on a machine with no recents yet.
 */
export function resolveDefaultSprintProject(input: {
  projects: readonly SprintProjectOption[]
  activeFolderPath: string | null
  recentFolders: readonly string[]
}): string | null {
  if (input.activeFolderPath) return input.activeFolderPath
  if (input.projects.length === 0) return null
  for (const recent of input.recentFolders) {
    const match = input.projects.find((project) => samePath(project.folderPath, recent))
    if (match) return match.folderPath
  }
  return input.projects[0].folderPath
}

/**
 * The handle a project is declared under. Derived from the folder name — the
 * thing the user just read — then disambiguated rather than dropping a real
 * project whose slug collides with one already taken or with `primary`.
 *
 * Returns null when the name yields no legal handle at all (a folder named
 * `---`); the engine's own pattern is the authority and would reject it.
 */
export function sprintRepoIdFor(folderPath: string, taken: ReadonlySet<string>): string | null {
  const base = slugifySiblingProjectId(basename(folderPath))
  if (!base) return null
  let id = base
  for (let suffix = 2; taken.has(id) || id === DEFAULT_SPRINTENGINE_TASK_REPO; suffix += 1) {
    id = `${base}-${suffix}`
  }
  return id
}

/**
 * `candidate` expressed relative to `primary` — `../multiauth` for the common
 * case of two projects side by side. Falls back to the absolute path when the
 * two share no ancestor (a different volume, or a Windows drive), which the
 * engine resolves just as happily.
 */
export function sprintRepoRootFor(primary: string, candidate: string): string {
  const primaryParts = trimPath(primary).replace(/\\/g, '/').split('/')
  const candidateParts = trimPath(candidate).replace(/\\/g, '/').split('/')
  let shared = 0
  while (
    shared < primaryParts.length
    && shared < candidateParts.length
    && primaryParts[shared].toLowerCase() === candidateParts[shared].toLowerCase()
  ) {
    shared += 1
  }
  // No shared ancestor beyond the filesystem root marker: not expressible as a
  // relative path in any useful way.
  if (shared <= 1) return trimPath(candidate)
  const up = primaryParts.length - shared
  return [...Array.from({ length: up }, () => '..'), ...candidateParts.slice(shared)].join('/')
}

export type SprintProjectRejection = {
  reason: string
}

/**
 * Whether a project can join the run, and in the user's words why not.
 *
 * MIRRORS `declared_sibling_root` in `sprintengine_core/tool/shell.py`, which is
 * the authority and refuses the same cases at init with the same reasons. This
 * runs first only so the wizard rejects the pick where it was made, instead of
 * failing a run someone already named and staffed.
 */
export async function validateSprintProjectSelection(
  input: {
    primaryFolderPath: string | null
    candidateFolderPath: string
    alreadyDeclared: readonly SprintDeclaredRepo[]
  },
  probe: SprintProjectProbe,
): Promise<SprintProjectRejection | null> {
  const { primaryFolderPath, candidateFolderPath, alreadyDeclared } = input
  const label = basename(candidateFolderPath) || candidateFolderPath
  if (!primaryFolderPath) {
    return { reason: 'Choose the project this sprint runs in first.' }
  }
  if (samePath(candidateFolderPath, primaryFolderPath)) {
    return { reason: `${label} is the project this sprint already runs in.` }
  }
  if (isInside(candidateFolderPath, primaryFolderPath)) {
    return { reason: `${label} is inside this sprint's project. A sprint spans separate projects.` }
  }
  if (isInside(primaryFolderPath, candidateFolderPath)) {
    return { reason: `${label} contains this sprint's project. Choose one beside it, not one that holds it.` }
  }
  if (alreadyDeclared.some((repo) => samePath(repo.folderPath, candidateFolderPath))) {
    return { reason: `${label} is already on this sprint.` }
  }
  if (!(await probe.pathExists(candidateFolderPath).catch(() => false))) {
    return { reason: `There is no folder at ${candidateFolderPath}.` }
  }
  // A repository root, not merely a folder inside one: the run gives each declared
  // project its own worktree and branch, which only a whole repository can hold.
  if (!(await probe.pathExists(`${trimPath(candidateFolderPath)}/.git`).catch(() => false))) {
    return { reason: `${label} is not a git project. A sprint can only span git projects.` }
  }
  if (!sprintRepoIdFor(candidateFolderPath, new Set())) {
    return { reason: `${label} has no name a sprint can refer to it by. Rename the folder to use it.` }
  }
  return null
}

/**
 * Validate and mint one declaration. Returns the rejection instead when the
 * project cannot join, so the caller shows the reason and changes nothing.
 */
export async function declareSprintProject(
  input: {
    primaryFolderPath: string | null
    candidateFolderPath: string
    displayName?: string
    alreadyDeclared: readonly SprintDeclaredRepo[]
  },
  probe: SprintProjectProbe,
): Promise<{ repo: SprintDeclaredRepo } | { rejection: SprintProjectRejection }> {
  const rejection = await validateSprintProjectSelection(input, probe)
  if (rejection) return { rejection }
  const primary = input.primaryFolderPath as string
  const taken = new Set(input.alreadyDeclared.map((repo) => repo.id))
  const id = sprintRepoIdFor(input.candidateFolderPath, taken)
  if (!id) {
    return { rejection: { reason: `${basename(input.candidateFolderPath)} has no name a sprint can refer to it by.` } }
  }
  return {
    repo: {
      id,
      root: sprintRepoRootFor(primary, input.candidateFolderPath),
      folderPath: input.candidateFolderPath,
      displayName: input.displayName?.trim() || basename(input.candidateFolderPath),
    },
  }
}

/**
 * What creation actually declares: `{id, root}` for the engine, dropped entirely
 * unless the run uses worktrees. A run can only span projects when each gets its
 * own worktree — the engine refuses the pair — so a selection stranded by the
 * worktree toggle is never sent rather than failing at init.
 */
export function sprintRepoDeclarations(
  repos: readonly SprintDeclaredRepo[],
  useWorktrees: boolean,
): Array<{ id: string; root: string }> {
  if (!useWorktrees) return []
  return repos.map((repo) => ({ id: repo.id, root: repo.root }))
}

/**
 * The declarations re-based on a new primary project. Switching the primary
 * keeps the other projects but moves their roots with it, and drops any that the
 * new primary now contains or sits inside — those are no longer separate projects.
 */
export function rebaseSprintRepos(
  repos: readonly SprintDeclaredRepo[],
  primaryFolderPath: string | null,
): SprintDeclaredRepo[] {
  if (!primaryFolderPath) return []
  return repos
    .filter(
      (repo) =>
        !samePath(repo.folderPath, primaryFolderPath)
        && !isInside(repo.folderPath, primaryFolderPath)
        && !isInside(primaryFolderPath, repo.folderPath),
    )
    .map((repo) => ({ ...repo, root: sprintRepoRootFor(primaryFolderPath, repo.folderPath) }))
}
