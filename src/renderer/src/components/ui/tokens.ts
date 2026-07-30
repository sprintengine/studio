// Shared UI tokens — TypeScript surface. CSS variables live in
// src/renderer/src/assets/index.css. This module exposes the semantic tone
// vocabulary that primitives accept so consumers do not pass raw colors.

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'error'

// Status vocabulary is one wider than the emphasis tones: `merged` is a status a
// dot can carry (a landed PR), never an emphasis a Select option or button asks
// for, so it lives here rather than widening `Tone`. Backed by --tone-merged
// (the GitHub-borrowed merged purple), a single base value with no per-theme
// override so "merged" stays recognisable across themes.
export type StatusTone = Tone | 'merged'

export type ToolIdentity = 'switchboard' | 'watchtower' | 'sprintengine'

export const TONE_COLOR_VAR: Record<Tone, string> = {
  neutral: 'var(--tone-neutral)',
  accent: 'var(--tone-accent)',
  good: 'var(--tone-good)',
  warn: 'var(--tone-warn)',
  error: 'var(--tone-error)',
}

export const STATUS_TONE_COLOR_VAR: Record<StatusTone, string> = {
  ...TONE_COLOR_VAR,
  merged: 'var(--tone-merged)',
}

export const TONE_SOFT_VAR: Record<Tone, string> = {
  neutral: 'var(--tone-neutral-soft)',
  accent: 'var(--tone-accent-soft)',
  good: 'var(--tone-good-soft)',
  warn: 'var(--tone-warn-soft)',
  error: 'var(--tone-error-soft)',
}

export const TOOL_COLOR_VAR: Record<ToolIdentity, string> = {
  switchboard: 'var(--tool-switchboard)',
  watchtower: 'var(--tool-watchtower)',
  sprintengine: 'var(--tool-sprintengine)',
}

// The product's one focus indicator: a 2px --border-focus outline at a 2px
// offset, declared once as the `focus-ring` utility in assets/index.css.
//
// The utility name is the single source, not these constants: markup that
// writes `focus-visible:focus-ring` into a className string lands on the same
// rule, and moving the treatment means editing the utility, never a consumer.
// What no component may do is declare a treatment of its own — a
// `focus-visible:ring-*` or `focus-visible:outline-*` carrying its own width or
// colour, which is how the accent collision below survived nineteen themes.
// That is enforced in ui/accessibility-contracts.test.ts. Prefer these four
// constants in new code: they carry the trigger's rationale, and the
// non-obvious ones (peer, wrapper) are easy to get wrong from memory.
//
// The offset is load-bearing, not decoration: --border-focus and
// --accent-primary are the same value in 18 of the 19 themes, so a zero-offset
// ring on an accent-filled control (PrimaryButton, a checked Switch) had nothing
// to contrast with and focused rendered identically to unfocused. The
// transparent gap is what separates them, and unlike `ring-offset-color` it
// assumes nothing about the fill behind the control.
//
// No `outline-none` companion: the outline replaces the UA one, and pairing it
// with an equal-specificity `focus:outline-none` would make which wins a matter
// of stylesheet order.
// WRITTEN OUT IN FULL, NEVER ASSEMBLED FROM `'focus-ring'` + a variant prefix.
// Tailwind v4 generates a rule only for a class candidate it can SEE as literal
// text while scanning source, and it does not evaluate template literals: a
// constant built as `` `peer-focus-visible:${FOCUS_RING_UTILITY}` `` produces no
// CSS at all, so every consumer of it silently renders with no focus indicator.
// That is not hypothetical — it is how the two variants below shipped inert
// (T13 review, 2026-07-30): `focus-visible:focus-ring` survived only because
// eight components happen to write it literally in their own className strings,
// while `peer-focus-visible:` and `has-[input:focus]:` were written nowhere else
// and so were absent from the built stylesheet entirely.
//
// So: one literal per constant, and grep for the literal — not for the constant
// name — when checking whether a variant reaches the CSS.

/** Focus on the element itself. The default — use this unless one of the below applies. */
export const FOCUS_RING_CLASS = 'focus-visible:focus-ring'

/**
 * Inward, for an element that clips its own overflow or sits at the edge of a
 * scrolling region: a focusable scroll container, a joined split-button half.
 * An outward gap is cut off there.
 */
export const FOCUS_RING_INSET_CLASS = 'focus-visible:focus-ring-inset'

/**
 * For a decorative box drawn next to the real control — a styled checkbox whose
 * `<input class="peer">` is the tab stop and carries the semantics.
 */
export const FOCUS_RING_PEER_CLASS = 'peer-focus-visible:focus-ring'

/**
 * For a wrapper that owns the visible border box while an `<input>` inside it is
 * the tab stop (a search field with a glyph and a clear button). Keyed to the
 * input's own focus, never `focus-within`: the clear button is a descendant, and
 * a `focus-within` outline stays painted while that button draws its own,
 * putting two indicators on one stop. `:focus` not `:focus-visible` because
 * Chromium treats text inputs as focus-visible on click anyway.
 */
export const FOCUS_RING_WITHIN_INPUT_CLASS = 'has-[input:focus]:focus-ring'
