// What the Design door reads out of a bundle directory (main-process reader ↔
// preload ↔ renderer). One IPC call per bundle: a 100-component bundle is ~300
// files, and walking it from the renderer with the generic filesystem IPC would
// be that many round-trips AND would put bundle-layout knowledge where the
// canonical manifest parser cannot enforce it.
//
// The payload carries the token CSS ONCE and per-component FRAGMENTS, not
// per-component whole documents: inlining the token block into 100 srcDocs would
// make the payload megabytes of duplicated text. The renderer composes each
// frame with `composePreviewSrcDoc`.
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

/** One swatch of the specimen's colour bar. */
export interface DesignSystemRampSwatch {
  /** Dotted token path, e.g. `ref.color.green.600`. */
  path: string
  light: string
  dark: string
}

export interface DesignSystemSpecimenView {
  /**
   * The emitted `:root` / `[data-mode="dark"]` block, shared by the specimen and
   * every component preview. Emitted from the token SOURCE, so a stale
   * `foundations/tokens.css` cannot make the door draw the wrong colours.
   */
  tokensCss: string
  /** The raw colour ramp, in document order — the specimen's one continuous bar. */
  ramp: DesignSystemRampSwatch[]
  /**
   * The bundle's own faces. A specimen set in OUR font is not a specimen, so the
   * display line uses these; null falls back to app chrome and must stay legible.
   */
  fontFamilyUi: string | null
  fontFamilyMono: string | null
  /** Token problems, surfaced rather than swallowed (see emitTokensCss). */
  problems: string[]
}

/** `component.md`'s five fixed sections, as authored. */
export interface DesignSystemComponentDoc {
  anatomy: string
  variants: string
  states: string
  usage: string
  accessibility: string
}

/** One top-level stage in a component's demo document. */
export interface DesignSystemStage {
  /** The stage's `data-mode`, when it declares one. */
  mode: string | null
  html: string
}

export interface DesignSystemComponentView {
  /** Directory name under `components/` — the component's id and its name. */
  name: string
  /** `component.css`, with bundle-relative `url()` refs inlined as data URIs. */
  css: string
  /** `<style>` blocks lifted from `component.html`, in document order. */
  inlineStyles: string[]
  /** Top-level `<body>` children of `component.html`, in order. */
  stages: DesignSystemStage[]
  /**
   * Counts read from `component.md`'s fixed Variants/States sections. Null when
   * the section is absent or unparseable — the tile then shows no count line
   * rather than a wrong number. The bundle format declares no variant MARKUP
   * contract, so prose is the only honest source.
   */
  variantCount: number | null
  stateCount: number | null
  doc: DesignSystemComponentDoc | null
  /** Bundle-relative refs that could not be inlined; reported, never silent. */
  unresolvedRefs: string[]
}

/** A pattern: one HTML file, rendered whole. */
export interface DesignSystemPatternView {
  name: string
  html: string
  inlineStyles: string[]
  unresolvedRefs: string[]
}

/** A glyph: one SVG file, inlined. `currentColor` by convention. */
export interface DesignSystemGlyphView {
  name: string
  svg: string
}

/** One section of the canvas, mirroring one `manifest.contents` key. */
export interface DesignSystemGroupView {
  /** The manifest `contents` key, preserving manifest (JSON) order. */
  key: string
  /** Sentence-case heading derived from the key. */
  label: string
  /** The entries the manifest declares for this group. */
  entries: string[]
  count: number
}

export interface DesignSystemBundleView {
  identity: DesignSystemBundleIdentity
  manifest: DesignSystemManifest
  specimen: DesignSystemSpecimenView
  /** One per NON-EMPTY declared `contents` key, in manifest order. */
  groups: DesignSystemGroupView[]
  components: DesignSystemComponentView[]
  patterns: DesignSystemPatternView[]
  glyphs: DesignSystemGlyphView[]
  /**
   * True when the data-URI inlining budget was exhausted, so some refs were
   * dropped for size rather than because they were missing. Said out loud —
   * a preview that silently lost its assets would look like a broken component.
   */
  assetBudgetExhausted: boolean
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
