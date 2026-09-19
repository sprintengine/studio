import { pathJoin } from './paths'

/**
 * The app-owned directory inside a workspace: worktrees, automation state, the
 * backlog link cache, browser captures, review data.
 */
export const SIDECAR_DIR_NAME = '.sprintengine'

/** A workspace's sidecar directory and where it sits. */
export type WorkspaceSidecar = {
  workspaceRoot: string
  root: string
}

export function sidecarFor(workspaceRoot: string): WorkspaceSidecar {
  return { workspaceRoot, root: pathJoin(workspaceRoot, SIDECAR_DIR_NAME) }
}

/** An absolute path under a sidecar root. */
export function sidecarPath(sidecar: WorkspaceSidecar, ...segments: string[]): string {
  return segments.length === 0 ? sidecar.root : pathJoin(sidecar.root, ...segments)
}

/**
 * A workspace-relative sidecar path, always POSIX-separated. This is the form
 * that gets STORED — durable backlog links, artifact paths, run references — so
 * it never takes the platform separator, on either platform.
 */
export function sidecarRelativePath(...segments: string[]): string {
  return [SIDECAR_DIR_NAME, ...segments].join('/')
}
