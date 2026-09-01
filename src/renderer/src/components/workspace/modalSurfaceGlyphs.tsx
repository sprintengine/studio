// Trigger glyphs for the modal surfaces in the sidebar footer's settings
// cluster (doors→modals, 2026-09-01). Deliberately a leaf file with no imports:
// modules register these EAGERLY (the glyph renders in the footer at boot), so
// anything imported here lands in the eager module-registry graph — which must
// stay free of the workspace store, AppIcons (which reaches the module
// registry), and every door bundle. One concept per glyph, currentColor
// strokes, the icon family's 16-box round-stroke idiom (design-system glyph
// grammar).

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
