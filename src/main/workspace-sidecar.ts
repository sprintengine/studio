import { statSync } from 'fs'
import {
  isAbsoluteFilePath,
  trimPath,
} from '../shared/paths'
import {
  forgetSidecarDirName,
  knownSidecarDirName,
  LEGACY_SIDECAR_DIR_NAME,
  rememberSidecarDirName,
  setUnknownSidecarDirNameResolver,
  SIDECAR_DIR_NAME,
  sidecarCandidates,
  sidecarFor,
  sidecarPath,
  type SidecarDirName,
  type WorkspaceSidecar,
} from '../shared/workspace-sidecar'

export type { SidecarDirName, WorkspaceSidecar }
export { SIDECAR_DIR_NAME, LEGACY_SIDECAR_DIR_NAME, sidecarPath }

const resolvedWorkspaceRoots = new Set<string>()

function isDirectory(pathValue: string): boolean {
  return statSync(pathValue, { throwIfNoEntry: false })?.isDirectory() === true
}

/**
 * The sidecar directory this workspace actually uses.
 *
 * Prefer `.sprintengine`; fall back to `.multi-code` when that is the only one
 * present; create `.sprintengine` for a workspace that has neither. When BOTH
 * exist the new one wins and the old one is left exactly where it is — not
 * merged, not deleted. Losing state silently is the one outcome worth ruling
 * out, and a directory nobody reads costs disk, which is recoverable.
 *
 * NOTHING HERE MIGRATES. An eager rename on workspace open would be a one-line
 * change and is deliberately not made, because the sidecar holds git worktrees
 * (`automations/worktrees/`) whose absolute paths are recorded in the parent
 * repository's `.git/worktrees/<name>/gitdir` and in each worktree's own `.git`
 * file. Renaming the directory out from under them detaches every one, and
 * repairing them is a git operation that can itself fail halfway. On top of
 * that the same workspace can be open in a second app instance — a dev build
 * beside a release build is the normal case here — which would keep writing to
 * the old path it resolved at ITS open, splitting a live sprint run's state
 * across two directories. A workspace therefore keeps the name it has until
 * someone renames it themselves, and the app reads whichever it finds.
 *
 * Sync so that path building stays sync: making this async would push `await`
 * into every caller that composes a sidecar path, most of which are themselves
 * called from sync code. The cost is one `statSync` per workspace per run.
 */
export function resolveWorkspaceSidecar(workspaceRoot: string): WorkspaceSidecar {
  const root = trimPath(workspaceRoot ?? '')
  // Asked before the workspace is known — a default-constructed record, a
  // relative path from a config, an empty string. There is nothing on disk to
  // consult, so answer with the current name and cache nothing.
  if (!root || !isAbsoluteFilePath(root)) return sidecarFor(workspaceRoot, SIDECAR_DIR_NAME)

  // Answered once per workspace per run: the question is asked on nearly every
  // path build, and the answer cannot change under a running app because
  // nothing renames a workspace's sidecar (see above). `forgetWorkspaceSidecar`
  // is the way back for a directory removed by hand, and for tests.
  if (resolvedWorkspaceRoots.has(root)) return sidecarFor(root, knownSidecarDirName(root))

  const dirName = sidecarCandidates(root).find((candidate) => isDirectory(candidate.root))?.dirName
    ?? SIDECAR_DIR_NAME
  rememberSidecarDirName(root, dirName)
  resolvedWorkspaceRoots.add(root)
  return sidecarFor(root, dirName)
}

/** The sidecar root for a workspace — `resolveWorkspaceSidecar(root).root`. */
export function workspaceSidecarRoot(workspaceRoot: string): string {
  return resolveWorkspaceSidecar(workspaceRoot).root
}

/** An absolute path inside a workspace's sidecar, under whichever name it uses. */
export function workspaceSidecarPath(workspaceRoot: string, ...segments: string[]): string {
  return sidecarPath(resolveWorkspaceSidecar(workspaceRoot), ...segments)
}

// Back the shared registry's fallback with the disk lookup, so a shared path
// builder reached in this process before anything resolved the workspace still
// answers from the workspace itself. Installed on import rather than from a
// startup sequence: every module that builds a sidecar path in main imports this
// one, so there is no ordering to get wrong.
setUnknownSidecarDirNameResolver((workspaceRoot) => resolveWorkspaceSidecar(workspaceRoot).dirName)

/**
 * Drop a memoized answer. Called when a workspace is removed, and by tests that
 * build a workspace on disk after having already asked about its root.
 */
export function forgetWorkspaceSidecar(workspaceRoot?: string): void {
  forgetSidecarDirName(workspaceRoot)
  if (workspaceRoot === undefined) resolvedWorkspaceRoots.clear()
  else resolvedWorkspaceRoots.delete(trimPath(workspaceRoot))
}
