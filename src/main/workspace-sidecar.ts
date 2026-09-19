import { SIDECAR_DIR_NAME, sidecarFor, sidecarPath, type WorkspaceSidecar } from '../shared/workspace-sidecar'

export type { WorkspaceSidecar }
export { SIDECAR_DIR_NAME, sidecarPath }

/** The sidecar root for a workspace. */
export function workspaceSidecarRoot(workspaceRoot: string): string {
  return sidecarFor(workspaceRoot).root
}

/** An absolute path inside a workspace's sidecar. */
export function workspaceSidecarPath(workspaceRoot: string, ...segments: string[]): string {
  return sidecarPath(sidecarFor(workspaceRoot), ...segments)
}
