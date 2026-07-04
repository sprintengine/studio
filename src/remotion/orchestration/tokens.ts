// Real Multicode operational (in-app dark) design tokens, mirrored from the
// live renderer so the Sprint Engine twin reads as *this* product. Sourced from
// src/renderer/src/utils/sprintengine.ts (role accents + labels) and the app's
// dark ink scale. Centralised here so the composition never scatters raw hex —
// change a token once and every scene follows.

import type { CSSProperties } from 'react'

// App ink scale (operational dark theme) — verbatim from
// src/renderer/src/assets/index.css `:root[data-theme="dark"]`. Channels are
// multiples of 4 (the app's anti-dither rule); pure black is avoided.
export const ink = {
  base: '#08080c', // --bg-app
  shell: '#08080c',
  surface: '#0c0c10', // --bg-surface
  surfaceRaised: '#101418', // --bg-surface-raised
  card: '#101418',
  hover: '#18181c', // --bg-hover
  selected: '#24242c', // --bg-selected
  terminal: '#040408', // --terminal-bg
  hairline: 'rgba(255,255,255,0.07)',
  hairlineSoft: 'rgba(255,255,255,0.05)',
  border: 'rgba(255,255,255,0.10)',
  textStrong: '#ececec', // --text-strong
  text: '#c8c8d0', // --text-default
  textMuted: '#9c9ca4', // --text-muted
  textSubtle: '#707078', // --text-subtle
  textDisabled: '#5c5c64', // --text-disabled
  onAccent: '#08080c', // --text-on-accent
  // The one product interactive accent is GREEN. Every CTA/selection/focus.
  accent: '#3f9468', // --accent-primary
  accentHover: '#4daf7d',
  accentSoft: 'rgba(63,148,104,0.16)',
  // Sprint Engine's *scoped identity* gold — the header identity dot and the
  // "just-moved" card pulse only. NOT the house/CTA accent.
  gold: '#ffbf2f',
  goldSoft: 'rgba(255,191,47,0.14)',
  toolAmber: '#fcc030', // --tool-sprintengine header dot / warn tone
  goodTone: '#30d058', // --tone-good
  warnTone: '#fcc030', // --tone-warn
  errorTone: '#fc787c', // --tone-error
} as const

// Canonical Sprint Engine role accents — verbatim from
// `sprintEngineRoleAccent` in src/renderer/src/utils/sprintengine.ts.
export const roleAccent = {
  architect: '#d4a757',
  product: '#e879a7',
  developer: '#c7ccd4',
  frontend: '#39d7ff',
  ui_ux_reviewer: '#8bdbca',
  tester: '#3dff8f',
  security: '#ff6b6b',
  code_reviewer: '#f59e0b',
  nuclear_reviewer: '#fb7185',
  spec_reviewer: '#22c55e',
  performance: '#a78bfa',
  production_readiness_reviewer: '#38bdf8',
  cross_platform: '#14b8a6',
} as const

export type RoleId = keyof typeof roleAccent

// Human labels — verbatim from `sprintEngineRoleLabels`.
export const roleLabel: Record<RoleId, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  ui_ux_reviewer: 'UI/UX Reviewer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
  nuclear_reviewer: 'Nuclear Reviewer',
  spec_reviewer: 'Spec Reviewer',
  performance: 'Performance Engineer',
  production_readiness_reviewer: 'Production Readiness Reviewer',
  cross_platform: 'Cross-platform Specialist',
}

// Vendor identity for the "bring your own model" story. The point of the film:
// any role can run on any vendor's CLI, billed to the user's own subscription.
// Chip colours are recognisable-but-restrained brand tints, used only as a
// small dot/label — never as a surface fill.
export type VendorId = 'anthropic' | 'openai' | 'zai'

export const vendor: Record<VendorId, { name: string; dot: string }> = {
  anthropic: { name: 'Anthropic', dot: '#d97757' },
  openai: { name: 'OpenAI', dot: '#10a37f' },
  zai: { name: 'Z.ai', dot: '#4d6bfe' },
}

export type ModelId =
  | 'fable-5'
  | 'mythos-5'
  | 'opus-4.8'
  | 'codex-5.5'
  | 'glm-5.2'

// Display names the marketing surface uses. Fable 5 is the most-capable
// orchestrator model; the others are worker/specialist runtimes.
export const model: Record<ModelId, { label: string; vendor: VendorId }> = {
  'fable-5': { label: 'Fable 5', vendor: 'anthropic' },
  'mythos-5': { label: 'Mythos 5', vendor: 'anthropic' },
  'opus-4.8': { label: 'Opus 4.8', vendor: 'anthropic' },
  'codex-5.5': { label: 'Codex 5.5', vendor: 'openai' },
  'glm-5.2': { label: 'GLM 5.2', vendor: 'zai' },
}

export const baseFont: CSSProperties = {
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  letterSpacing: 0,
}

export const monoFont: CSSProperties = {
  fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  letterSpacing: 0,
}

// Premium motion personality (the composition's single archetype).
// cubic-bezier(0.4, 0, 0.2, 1), 350–600ms, ~0% overshoot.
export const premiumBezier = [0.4, 0, 0.2, 1] as const
export const entranceBezier = [0.16, 1, 0.3, 1] as const
