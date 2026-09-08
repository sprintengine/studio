// Result shapes for attaching a design-system bundle to a consuming
// workspace (main-process attach ↔ preload ↔ renderer). Attach is a one-time
// copy to <workspace>/design-system/ with provenance stamped into the copy —
// no live sync, no re-materialize-on-update, and never an overwrite or merge
// when the target already exists. Bundle format contract:
// resources/design-system/templates/USAGE.md.

/**
 * Where the bundle comes from: an entry in the user-global library
 * (name+version resolve under the library root), or any browsed folder as the
 * escape hatch (validated as a bundle before anything is copied).
 */
export type DesignSystemAttachSource =
  /** A folder registered in the library, addressed by its registration id. */
  | { kind: 'library'; id: string }
  /** Any folder on disk, addressed directly (the new-workspace browse row). */
  | { kind: 'folder'; path: string }

/**
 * Stage that refused the attach. Nothing is written into the workspace on any
 * failure: `source` is an unreadable/invalid bundle, `target` a missing
 * workspace root, `conflict` an existing design-system/ in the workspace.
 */
type DesignSystemAttachFailureStage =
  | 'request'
  | 'source'
  | 'target'
  | 'conflict'
  | 'copy'

/**
 * The one dedicated agent-launch prompt line for consuming workspaces.
 * Injected when and only when `design-system/` exists in the agent's
 * execution root — KG-independent by design (plan contract line).
 */
export const DESIGN_SYSTEM_ATTACHED_PROMPT_LINE =
  'A design system is attached at `design-system/`; read `USAGE.md` + `foundations/tokens.css` + `components/` and conform — do not invent styles.'

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

/**
 * Result of removing `<workspace>/design-system/`. `removed: false` means
 * there was nothing to remove — detach is idempotent, so that is still ok.
 */
export type DesignSystemDetachResult =
  | { ok: true; removed: boolean }
  | { ok: false; message: string }
