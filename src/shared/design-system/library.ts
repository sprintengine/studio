// Result shapes for the user-global design-system library (main-process
// registry ↔ preload ↔ renderer). Releases are immutable, versioned bundle
// copies under ~/.multicode/design-systems/<name>/<version>/; the authoring
// workspace stays the editable source (edit = reopen, iterate, re-release).
// Layout and release contract: knowledge/multicode/design-system-bundle.md.

import type { DesignSystemManifest } from './manifest'

/** One released design system in the user-global library. */
export interface DesignSystemLibraryEntry {
  name: string
  version: string
  summary: string
  /** ISO timestamp stamped into manifest provenance at release. */
  releasedAt: string | null
  /** Absolute path of the released bundle copy. */
  path: string
}

/** A library directory entry that could not be read as a released bundle. */
export interface DesignSystemLibraryRejection {
  path: string
  message: string
}

export interface DesignSystemLibraryListResult {
  /** Sorted by name, then newest version first. */
  entries: DesignSystemLibraryEntry[]
  /** Malformed releases surfaced for repair — never silently skipped. */
  rejected: DesignSystemLibraryRejection[]
}

export type DesignSystemLibraryReadResult =
  | { ok: true; entry: DesignSystemLibraryEntry; manifest: DesignSystemManifest }
  | { ok: false; message: string }

/**
 * Pipeline stage that refused a release. Nothing is copied into the library
 * on any failure; `lint` failures carry the lint report in `lintFindings`.
 * `source` refuses a bundle tree that is unsafe to copy verbatim (a symlink
 * escaping the bundle).
 */
export type DesignSystemReleaseFailureStage =
  | 'request'
  | 'manifest'
  | 'lint'
  | 'regenerate'
  | 'source'
  | 'conflict'
  | 'copy'

export type DesignSystemReleaseResult =
  | {
      ok: true
      name: string
      version: string
      /** ISO timestamp stamped into the released manifest's provenance. */
      releasedAt: string
      /** Absolute path of the immutable released copy. */
      path: string
    }
  | {
      ok: false
      stage: DesignSystemReleaseFailureStage
      message: string
      /** stdout of the bundle's scripts/lint.mjs when stage is 'lint'. */
      lintFindings?: string
    }
