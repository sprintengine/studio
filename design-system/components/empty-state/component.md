# Empty state

**Status: shipped 2026-08-05** (MC-2117) — `src/renderer/src/components/ui/`.

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

## As shipped

Two densities, because the five hand-rolls were doing two different jobs:

| Density | Where | Shape |
|---|---|---|
| `pane` (default) | a region with nothing in it — no workspace open, nothing selected | fills the height, centred |
| `list` | a list that came back empty | top-aligned and compact |

Title in `text.muted`, optional body in `text.subtle`, optional glyph in the
`icon.size.lg` slot the token's own comment reserves for exactly this, and at
most one action.

**Ruling — copy is readable ink, never `text.disabled`.** One hand-roll rendered
its sentence in `text.disabled`: copy meant to be read, greyed out as though it
were a dead control, next to the only thing on screen you could actually do.

**Ruling — no accent disc, and `SurfaceCanvasState` is not generalized into
this.** The intent above proposed basing this on `SurfaceCanvasState`'s anatomy
(a glyph in an `accent.soft` disc). They are different jobs. A door's *first-run*
canvas earns a prominent accent treatment; a list that filtered down to nothing
does not, and giving every empty list an accent disc would spend the accent
budget on absence. `SurfaceCanvasState` keeps its richer door-canvas treatment;
this is the quiet general one.
