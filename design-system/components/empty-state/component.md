# Empty state

**Status: planned — not yet shipped.** Built by MC-2117.

What a surface shows when it has nothing to show: a glyph, a title, an
optional body line, and at most one call-to-action — never a dead end on a
first-run surface. Five local `EmptyState` components re-declare this idea
today (`workspace/WorkspaceManager.tsx`, `AutomationsPanel.tsx`,
`AutomationsList.tsx`, `SkillsDiscover.tsx`, `SkillSourceCanvas.tsx`), and
the `icon.size.lg` token already names "empty-state glyphs" as a use with no
component to consume it. The likely base is `SurfaceCanvasState` in
`workspace/globalSurface/surfaceSubstrate.tsx` — the six-door unification
that already renders one shared loading/empty/error anatomy (glyph in an
`accent.soft` disc, title, one CTA) across every global surface. This entry
generalizes that anatomy; MC-2115's consolidation consumes it.
