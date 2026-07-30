// The product wordmark. Ported from the marketing site's `Wordmark`
// (../sprintengine-website/components/BrandMark.tsx) so the app and the site
// set the name the same way: Inter semibold, -0.011em tracking, "engine" in the
// accent.
//
// Live DOM text, not an SVG `<text>`. The wordmark this replaced was drawn as
// SVG text and so scaled by viewBox rather than by the type ramp, which put it
// outside every type rule in the system. As text it takes `text-heading` (14px)
// from the ramp and `--text-strong` / `--accent-primary` from the active theme.
//
// The accent is ink here, never a fill: the wordmark is inside the sidebar's
// accent budget precisely because it colors letterforms and nothing else. The
// mark glyph is deliberately absent — it is the application icon and nothing
// else (owner, 2026-07-29), so no UI is coupled to it.
//
// This renders in exactly one place, the sidebar's brand row (SidebarChrome).
// See the window-chrome carve-out in design-system/foundations/principles.md
// under "The product does not name itself".

type SprintEngineWordmarkProps = {
  className?: string
}

export default function SprintEngineWordmark({ className = '' }: SprintEngineWordmarkProps) {
  return (
    <span
      className={`inline-flex items-baseline text-heading font-semibold leading-none tracking-[-0.011em] text-[color:var(--text-strong)] ${className}`}
    >
      sprint
      <span className="text-[color:var(--accent-primary)]">engine</span>
    </span>
  )
}
