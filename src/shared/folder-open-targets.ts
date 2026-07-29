// The fixed set of places a workspace folder can be opened from the
// open-in-editor control. Renderer and main share this list so the probe result
// and the open request cannot drift apart.
export const FOLDER_OPEN_TARGET_IDS = ['vscode', 'intellij', 'finder'] as const

export type FolderOpenTargetId = (typeof FOLDER_OPEN_TARGET_IDS)[number]

export function isFolderOpenTargetId(value: unknown): value is FolderOpenTargetId {
  return typeof value === 'string' && (FOLDER_OPEN_TARGET_IDS as readonly string[]).includes(value)
}

/**
 * One entry per target, always all of them. `available` is true only when the
 * launcher genuinely resolves — the editor CLI on PATH or an installed
 * application bundle — so a false entry means the editor is not installed and
 * the control must omit it rather than show it disabled. The file manager is
 * always available: it is the OS reveal that already ships.
 */
export type FolderOpenTargetAvailability = {
  id: FolderOpenTargetId
  available: boolean
}

export type FolderOpenRequest = {
  target: FolderOpenTargetId
  path: string
}

/**
 * Why a launch did not happen. Callers surface the failure; nothing retries a
 * different target on their behalf.
 */
export type FolderOpenFailureReason =
  /** `target` was not one of the known ids. */
  | 'unknown_target'
  /** The folder path was empty, or unreadable at launch time. */
  | 'path_unavailable'
  /** The target's launcher no longer resolves (uninstalled since the probe). */
  | 'target_unavailable'
  /** The launcher resolved but exited with a failure. */
  | 'launch_failed'

export type FolderOpenResult =
  | { ok: true; target: FolderOpenTargetId }
  | { ok: false; target: FolderOpenTargetId | null; reason: FolderOpenFailureReason; message: string }
