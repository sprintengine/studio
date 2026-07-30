// Result shapes for the user-global design-system library (main-process
// registry ↔ preload ↔ renderer). Bundles live under
// ~/.multicode/design-systems/<name>/<version>/ and the library is read-only to
// this app: an app-local release pipeline was removed 2026-07-30 because a
// design system belongs in a Git repo, versioned by its owner there.
// Layout contract: knowledge/multicode/design-system-bundle.md.

import type { DesignSystemManifest } from './manifest'

/** One design system in the user-global library. */
export interface DesignSystemLibraryEntry {
  name: string
  version: string
  summary: string
  /** The bundle manifest's own `provenance.releasedAt`, when it carries one.
   *  A field of the bundle format we read, not an app-owned release record. */
  releasedAt: string | null
  /** Absolute path of the bundle directory. */
  path: string
}

/** A library directory entry that could not be read as a bundle. */
export interface DesignSystemLibraryRejection {
  path: string
  message: string
}

export interface DesignSystemLibraryListResult {
  /** Sorted by name, then newest version first. */
  entries: DesignSystemLibraryEntry[]
  /** Malformed entries surfaced for repair — never silently skipped. */
  rejected: DesignSystemLibraryRejection[]
}

export type DesignSystemLibraryReadResult =
  | { ok: true; entry: DesignSystemLibraryEntry; manifest: DesignSystemManifest }
  | { ok: false; message: string }
