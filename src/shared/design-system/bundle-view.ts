// What the Design door reads out of a bundle directory (main-process reader ↔
// preload ↔ renderer). One IPC call per bundle: a 100-component bundle is ~300
// files, and walking it from the renderer with the generic filesystem IPC would
// be that many round-trips AND would put bundle-layout knowledge where the
// canonical manifest parser cannot enforce it.
//
// Item 2002 (the door shell) needs the identity a rail row carries. Item 2003
// extends THIS shape with the specimen ramp, the per-group contents, and the
// per-component preview fragments the canvas renders — same channel, one reader.
//
// The door is read-only: nothing here writes into a bundle folder or forks a
// bundle script. Contract: knowledge/multicode/design-system-bundle.md.

import type { DesignSystemManifest } from './manifest'

/**
 * Why a bundle directory could not be read. Distinct cases, because a folder we
 * cannot read must never render identically to a system with no components —
 * the rail names which one it is, with the path visible.
 */
export type DesignSystemBundleReadFailure =
  /** The path is gone, or is not a directory (moved, renamed, unmounted). */
  | 'missing'
  /** The directory exists but carries no `design-system.json`. */
  | 'no-manifest'
  /** The manifest is present and does not parse against schema v1. */
  | 'invalid-manifest'
  /** Permission denied, or an I/O error. */
  | 'unreadable'

/** A bundle's identity, as a rail row shows it. */
export interface DesignSystemBundleIdentity {
  /** Absolute path of the bundle directory — the row's stable identity. */
  path: string
  name: string
  version: string
  summary: string
  /**
   * The bundle's own `sem.color.accent.primary`, resolved from
   * `foundations/tokens.tokens.json` per mode. Null when the bundle declares no
   * accent or its alias chain is broken — the row then shows no identity chip
   * rather than a fabricated colour.
   */
  accent: { light: string | null; dark: string | null }
}

export interface DesignSystemBundleView {
  identity: DesignSystemBundleIdentity
  manifest: DesignSystemManifest
}

export type DesignSystemBundleReadResult =
  | { ok: true; view: DesignSystemBundleView }
  | {
      ok: false
      reason: DesignSystemBundleReadFailure
      /** Always carried, so a broken row can name the path it was pointed at. */
      path: string
      message: string
    }
