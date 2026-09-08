// Result shape for design-system bundle scaffolding (main-process service ↔
// preload ↔ renderer). Scaffolding stamps the bundle layout from
// resources/design-system/templates into a workspace so the Design Wizard's
// design-system preset starts from a well-formed, lintable bundle — see
// resources/design-system/templates/USAGE.md for the layout contract.

/**
 * Where the bundle lives inside a workspace, for both the main-process writer
 * (scaffold, runner discovery) and the renderer watcher/indexer (studio).
 * Single definition on the shared boundary so the two sides cannot drift;
 * attach uses the same directory name.
 */
export const DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME = 'design-system'

export interface DesignSystemScaffoldResult {
  /** False when the layout could not be written; `message` explains why. */
  ok: boolean
  /** Absolute path of the bundle directory (set on success). */
  bundleDir?: string
  /**
   * True when a bundle already existed at the target (its manifest is
   * present). The scaffold never overwrites an existing bundle — reopening a
   * design-system workspace resumes it instead.
   */
  alreadyExisted?: boolean
  /** Human-readable failure summary when ok is false. */
  message?: string
}
