// The glyphs modules hand to the shell's chrome to name a surface: an app-rail
// square (Automations), an Extensions drawer row (Design, Plugins), a pane
// launcher (Reviews). "Modal" left the name with the Extensions drawer ruling
// (2026-09-05) — most of these name doors now, and the glyph never cared which
// mount kind was behind it.
//
// Deliberately a LEAF file: modules register these EAGERLY (the glyph renders in
// the rail at boot), so anything imported here lands in the eager
// module-registry graph — which must stay free of the workspace store, AppIcons
// (which reaches the module registry), and every door bundle. The one import
// below is the brand mark, which is itself a leaf for the same reason (see its
// header). One concept per glyph, currentColor strokes, the icon family's
// 16-box round-stroke idiom (design-system glyph grammar).

import { SprintEngineFrond } from '../brand/SprintEngineFrond'

// Sprints: the SprintEngine frond, the same mark its drawer row wears
// (SprintsNavEntry, through AppIcons' SprintEngineWorkspaceTypeIcon — the same
// component, reached the long way round because AppIcons may not be imported
// here). The sprint-engine module hands this to the shell so the Extensions
// home's Sprints tile can be drawn from the registry like the other four,
// rather than the shell hard-coding a glyph for one module's row
// (Extensions drawer ruling, 2026-09-05, Stage 3).
export function SprintsGlyph({ className }: { className?: string }) {
  return <SprintEngineFrond className={className} tone="current" />
}

// Workflows: one goal fanning out into the work it turns into (item 2470). Its
// concept is the split itself — a single thing on the left becoming several on
// the right — which is what separates this door from Sprints, where the several
// were written down before the run began. Drawn on the same 16 box in the icon
// family's round-stroke idiom, so the two rows read as siblings in the drawer.
export function WorkflowsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="3.6" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.3 8h1.5M6.8 8c1.8 0 1.8-4 3.6-4M6.8 8h3.6M6.8 8c1.8 0 1.8 4 3.6 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="11.9" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.9" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.9" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// Plugins: a link to an external capability. Moved verbatim from the retired
// ExtensionsNavEntry (where it was the Extensions door's row icon).
export function PluginsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M6.6 9.4L9.4 6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M8.7 4.6l.9-.9a2.3 2.3 0 0 1 3.3 3.3l-1.4 1.4a2.3 2.3 0 0 1-3.3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.3 11.4l-.9.9a2.3 2.3 0 0 1-3.3-3.3l1.4-1.4a2.3 2.3 0 0 1 3.3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Automations: the bolt-in-arc mark, redrawn on the 16 grid from AppIcons'
// AutomationsWorkspaceTypeIcon (24 grid). Duplicated rather than imported —
// AppIcons reaches the module registry, which this leaf must not.
export function AutomationsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-2.27-4.19"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M8.4 4.9 6 8.3h1.8l-.47 2.66L9.73 7.6H7.93l.47-2.7z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.18"
      />
    </svg>
  )
}

// Design: overlapping swatches — a set of decided values. Moved verbatim from
// the retired DesignNavEntry.
export function DesignGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect
        x="2.2"
        y="2.2"
        width="7"
        height="7"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M11.2 6.8h2a.8.8 0 0 1 .8.8v5.2a.8.8 0 0 1-.8.8H7.6a.8.8 0 0 1-.8-.8v-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Reviews: an eye — the guided walkthrough of a change. Moved verbatim from the
// retired ReviewsNavEntry (the Reviews door's row icon) when Reviews became a
// modal surface opened from the workspace pane (2026-09-05).
export function ReviewsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
