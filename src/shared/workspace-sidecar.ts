import { pathJoin } from './paths'

/**
 * The app-owned directory inside a workspace: worktrees, sprint run stores,
 * automation state, the backlog link cache, browser captures, review data.
 *
 * It was called `.multi-code` before the app was renamed (2026-09-08) and is
 * called `.sprintengine` now, but the old name is on every existing user's disk
 * holding live state, so both are read for as long as any workspace still has
 * one. A workspace has exactly one of them; which one is decided per workspace
 * by {@link resolveWorkspaceSidecar} in the main process, and the answer is
 * carried around as a {@link WorkspaceSidecar} rather than re-derived.
 */
export const SIDECAR_DIR_NAME = '.sprintengine'
export const LEGACY_SIDECAR_DIR_NAME = '.multi-code'

/** Both names, preferred first. This is the read order everywhere. */
export const SIDECAR_DIR_NAMES = [SIDECAR_DIR_NAME, LEGACY_SIDECAR_DIR_NAME] as const

export type SidecarDirName = (typeof SIDECAR_DIR_NAMES)[number]

export function isSidecarDirName(segment: string): segment is SidecarDirName {
  return segment === SIDECAR_DIR_NAME || segment === LEGACY_SIDECAR_DIR_NAME
}

/**
 * A regex fragment matching either name, for the handful of places that read a
 * sidecar path out of a string rather than walking segments. Built from the
 * constants so a future third spelling cannot be added to one and missed by the
 * other; the escape is explicit because the names begin with a dot.
 */
export const SIDECAR_DIR_PATTERN_SOURCE = `(?:${SIDECAR_DIR_NAMES.map((name) => name.replace(/\./gu, '\\.')).join('|')})`

/**
 * Which sidecar directory a workspace uses, and where it sits.
 *
 * `dirName` is the whole decision; `root` is the join, cached so the common
 * case is a field read. Mirrors `BacklogLocation` deliberately: resolve once at
 * the edge, pass the resolved value down, and never let a path-building helper
 * deep in a call stack guess.
 */
export type WorkspaceSidecar = {
  workspaceRoot: string
  dirName: SidecarDirName
  root: string
}

/**
 * A sidecar under an explicit name. Defaults to the current name, which is what
 * a caller with no workspace on disk to consult should use — a brand new
 * workspace, a path shown in the UI, a fixture.
 */
export function sidecarFor(workspaceRoot: string, dirName: SidecarDirName = SIDECAR_DIR_NAME): WorkspaceSidecar {
  return { workspaceRoot, dirName, root: pathJoin(workspaceRoot, dirName) }
}

/** An absolute path under a resolved sidecar root. */
export function sidecarPath(sidecar: WorkspaceSidecar, ...segments: string[]): string {
  return segments.length === 0 ? sidecar.root : pathJoin(sidecar.root, ...segments)
}

/**
 * A workspace-relative sidecar path, always POSIX-separated. This is the form
 * that gets STORED — durable backlog links, artifact paths, run references — so
 * it never takes the platform separator, on either platform.
 */
export function sidecarRelativePath(dirName: SidecarDirName, ...segments: string[]): string {
  return [dirName, ...segments].join('/')
}

/**
 * The sidecar name a path is under, or null if it is not under one. Separators
 * are normalized first: a Windows caller passes `C:\repo\.sprintengine\...` and
 * a stored value is POSIX, and both have to answer the same.
 */
export function sidecarDirNameOfPath(pathValue: string): SidecarDirName | null {
  for (const segment of pathValue.replace(/\\/gu, '/').split('/')) {
    if (isSidecarDirName(segment)) return segment
  }
  return null
}

/**
 * Drop a leading sidecar segment from an already-split path, under either name,
 * or return null when the path does not start with one. Returning the remainder
 * rather than a boolean keeps the two facts a caller needs — "is this a sidecar
 * path" and "what is under it" — from being derived twice out of step.
 */
export function withoutSidecarPrefix(segments: readonly string[]): string[] | null {
  const [first, ...rest] = segments
  return first !== undefined && isSidecarDirName(first) ? rest : null
}
