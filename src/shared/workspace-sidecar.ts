import { pathJoin } from './paths'

/**
 * The app-owned directory inside a workspace: worktrees, automation state, the
 * backlog link cache, browser captures, review data.
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
 * A sidecar under an explicit name. Defaults to {@link knownSidecarDirName}, so
 * a caller that has no way to look at the disk still gets the right answer for
 * a workspace someone else has already resolved.
 */
export function sidecarFor(workspaceRoot: string, dirName?: SidecarDirName): WorkspaceSidecar {
  const name = dirName ?? knownSidecarDirName(workspaceRoot)
  return { workspaceRoot, dirName: name, root: pathJoin(workspaceRoot, name) }
}

/**
 * Which name each workspace root uses, as far as THIS process has been told.
 *
 * Two processes need the answer and only one of them can read a disk. The main
 * process resolves it (`resolveWorkspaceSidecar`, which stats) and records it
 * here; the renderer is told over IPC and records it here. Everything else —
 * the run-store path builders, the backlog config path, the automations team
 * picker — reads it, so neither process has to thread a directory name through
 * every call that builds a path.
 *
 * A root that nobody has resolved reads as the current name. That is right for
 * the two cases it covers: a workspace that does not exist yet, and a path
 * being rendered before its workspace has been opened.
 */
const sidecarDirNameByWorkspaceRoot = new Map<string, SidecarDirName>()

function workspaceKey(workspaceRoot: string): string {
  return workspaceRoot.replace(/[\\/]+$/u, '')
}

/**
 * A last resort for a root nobody has recorded, installed by whichever process
 * can answer without being told. The main process installs the disk lookup, so
 * a path built there for a workspace it has not touched yet still lands in that
 * workspace's own sidecar rather than creating a second one beside it — which
 * would flip the whole workspace's resolution on its next open and orphan every
 * run, worktree and automation under the first. The renderer installs nothing
 * and falls through to the current name.
 */
let resolveUnknownSidecarDirName: ((workspaceRoot: string) => SidecarDirName) | null = null

export function setUnknownSidecarDirNameResolver(
  resolver: ((workspaceRoot: string) => SidecarDirName) | null,
): void {
  resolveUnknownSidecarDirName = resolver
}

export function rememberSidecarDirName(workspaceRoot: string, dirName: SidecarDirName): void {
  sidecarDirNameByWorkspaceRoot.set(workspaceKey(workspaceRoot), dirName)
}

export function knownSidecarDirName(workspaceRoot: string): SidecarDirName {
  const recorded = sidecarDirNameByWorkspaceRoot.get(workspaceKey(workspaceRoot))
  if (recorded) return recorded
  return resolveUnknownSidecarDirName?.(workspaceRoot) ?? SIDECAR_DIR_NAME
}

/** Drop one workspace's recorded name, or every one when called with nothing. */
export function forgetSidecarDirName(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) sidecarDirNameByWorkspaceRoot.clear()
  else sidecarDirNameByWorkspaceRoot.delete(workspaceKey(workspaceRoot))
}

/**
 * The directories to look for, in the order they decide the answer: the current
 * name first, then the legacy one.
 *
 * Exported as data rather than as a resolver because the two processes that
 * need it cannot ask the same way — the main process stats synchronously, the
 * renderer asks over IPC and awaits — and the ORDER is the part that must not
 * differ between them. Neither existing means a workspace that has no sidecar
 * yet, which takes the current name.
 */
export function sidecarCandidates(workspaceRoot: string): WorkspaceSidecar[] {
  return SIDECAR_DIR_NAMES.map((dirName) => sidecarFor(workspaceRoot, dirName))
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
