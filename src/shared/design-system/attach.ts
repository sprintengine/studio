// Result shapes for attaching a released design-system bundle to a consuming
// workspace (main-process attach ↔ preload ↔ renderer). Attach is a one-time
// copy to <workspace>/design-system/ with provenance stamped into the copy —
// no live sync, no re-materialize-on-update, and never an overwrite or merge
// when the target already exists. Contract:
// knowledge/multicode/design-system-bundle.md.

/**
 * Where the bundle comes from: a release in the user-global library
 * (name+version resolve under the library root), or any browsed folder as the
 * escape hatch (validated as a bundle before anything is copied).
 */
export type DesignSystemAttachSource =
  | { kind: 'library'; name: string; version: string }
  | { kind: 'folder'; path: string }

/**
 * Stage that refused the attach. Nothing is written into the workspace on any
 * failure: `source` is an unreadable/invalid bundle, `target` a missing
 * workspace root, `conflict` an existing design-system/ in the workspace.
 */
export type DesignSystemAttachFailureStage =
  | 'request'
  | 'source'
  | 'target'
  | 'conflict'
  | 'copy'

export type DesignSystemAttachResult =
  | {
      ok: true
      name: string
      version: string
      /** ISO timestamp stamped into the attached copy's provenance. */
      attachedAt: string
      /** Absolute path of the attached copy (<workspace>/design-system). */
      path: string
    }
  | {
      ok: false
      stage: DesignSystemAttachFailureStage
      message: string
    }
