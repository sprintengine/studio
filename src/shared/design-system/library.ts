// The user-global design-system library (main-process registry ↔ preload ↔
// renderer).
//
// **The library is a list of references, not a store of copies.** Owner ruling
// 2026-07-30: a design system lives in a Git repo the user clones, versions and
// pulls themselves. We point at the folder and read it live. Nothing here copies
// a bundle anywhere, and nothing writes inside a registered folder.
//
// It used to be a copy store, written by an app-local release pipeline that item
// 2001 deleted. With nothing writing copies, keeping the copy store would have
// left a library that could only ever shrink. Copies from that era are ADOPTED as
// registered paths pointing at themselves — never moved, never deleted.
//
// Contract: knowledge/multicode/design-system-bundle.md.

import type { DesignSystemManifest } from './manifest'

/** Registry schema version, so a future shape change has a migration point. */
export const DESIGN_SYSTEM_REGISTRY_SCHEMA_VERSION = 1

/** One folder the user has pointed at. */
export interface DesignSystemRegistration {
  /**
   * Stable id: an FNV-1a hash of the normalised absolute path.
   *
   * Keyed by PATH rather than by name@version because two cloned repos can
   * legitimately hold the same name and version — a collision the old
   * `<name>/<version>/` addressing could not express. A name clash is a display
   * concern, never an error.
   */
  id: string
  /** Absolute bundle directory. Deliberately outside our storage. */
  path: string
  /**
   * Name and version as last read from the manifest.
   *
   * DISPLAY CACHE ONLY — so a row can render before its read lands, and so a
   * folder that has gone missing still shows what it used to be. Never the
   * source of truth: both are re-read from the manifest on every open.
   */
  name: string | null
  version: string | null
  /** ISO timestamp the path was registered. */
  addedAt: string
}

export interface DesignSystemRegistryFile {
  schemaVersion: number
  entries: DesignSystemRegistration[]
  /**
   * Whether release-era copies under the old library root have been adopted.
   *
   * Recorded so adoption runs once: a user who deliberately forgets an adopted
   * copy must not have it reappear on the next read.
   */
  adoptedLegacyCopies?: boolean
}

/**
 * Why a registered folder cannot be read right now.
 *
 * Distinct states, because a folder that moved, a folder that never was a
 * bundle, a bundle whose manifest broke, and a folder we lack permission for are
 * four different problems with four different fixes. A row shows which one it
 * is, with its path — never a disappeared row and never a generic error.
 */
export type DesignSystemSourceState =
  | 'ok'
  | 'missing'
  | 'no-manifest'
  | 'invalid-manifest'
  | 'unreadable'

/** One design system in the library, as the rail lists it. */
export interface DesignSystemLibraryEntry {
  /** The registration id — the entry's stable identity. */
  id: string
  /** Absolute path of the bundle directory. */
  path: string
  /** From the manifest when readable, else the last cached value, else null. */
  name: string | null
  version: string | null
  summary: string
  /** The bundle manifest's own `provenance.releasedAt`, when it carries one.
   *  A field of the bundle format we read, not an app-owned release record. */
  releasedAt: string | null
  /** Whether this folder can be read, and if not, how it is broken. */
  sourceState: DesignSystemSourceState
  addedAt: string
}

export interface DesignSystemLibraryListResult {
  /** Sorted by display name (cached for a broken entry), then by path. */
  entries: DesignSystemLibraryEntry[]
}

export type DesignSystemLibraryReadResult =
  | { ok: true; entry: DesignSystemLibraryEntry; manifest: DesignSystemManifest }
  | { ok: false; message: string; sourceState: DesignSystemSourceState }

export type DesignSystemRegisterResult =
  | { ok: true; entry: DesignSystemLibraryEntry }
  | { ok: false; message: string }

/**
 * FNV-1a over the normalised path — the same hashing the Backlog object ids use.
 *
 * Not cryptographic and does not need to be: it is a stable local key for a
 * string the user chose, and a collision would only ever merge two rows the user
 * can re-point.
 */
export function designSystemRegistrationId(absolutePath: string): string {
  const normalised = normaliseRegistryPath(absolutePath)
  let hash = 0x811c9dc5
  for (let index = 0; index < normalised.length; index += 1) {
    hash ^= normalised.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * One spelling per folder: trailing separators dropped, and `\` folded to `/`.
 *
 * Case is NOT folded. macOS and Windows are usually case-insensitive and Linux
 * is not, and treating two genuinely different Linux folders as one entry would
 * silently lose a system — the wrong way to be wrong.
 */
export function normaliseRegistryPath(absolutePath: string): string {
  return absolutePath.replace(/\\/g, '/').replace(/\/+$/, '')
}
