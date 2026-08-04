# Table

**Status: planned — not yet shipped.** Built by MC-2117.

The shared header/row/cell chrome for genuinely tabular data — columns of
values compared across rows, where `list-row` (a pick-an-item list) is the
wrong shape. Three bespoke implementations ship today: hand-rolled `<table>`
markup in `panels/SprintEngineRunSummaryPanel.tsx` and
`diagnostics/DiagnosticsContent.tsx`, plus a third div-grid variant in
`workspace/newWorkspace/SprintEngineRosterTable.tsx`. This entry replaces all
three with one contract: real `<table>` semantics, `font.size.meta` header
row in `text.muted`, `border.subtle` row hairlines, mono tabular numerals for
numeric cells, and no per-surface reinvention of alignment or padding.
