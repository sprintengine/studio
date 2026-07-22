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

export type ToolIdentity = 'switchboard' | 'watchtower' | 'sprintengine' | 'multiloop'

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
  multiloop: 'var(--tool-multiloop)',
}

export const FOCUS_RING_CLASS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]'
