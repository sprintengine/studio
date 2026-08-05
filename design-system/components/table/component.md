# Table

**Status: shipped 2026-08-05** (MC-2117) — `src/renderer/src/components/ui/`.

The shared header/row/cell chrome for genuinely tabular data — columns of
values compared across rows, where `list-row` (a pick-an-item list) is the
wrong shape. Three bespoke implementations ship today: hand-rolled `<table>`
markup in `panels/SprintEngineRunSummaryPanel.tsx` and
`diagnostics/DiagnosticsContent.tsx`, plus a third div-grid variant in
`workspace/newWorkspace/SprintEngineRosterTable.tsx`. This entry replaces all
three with one contract: real `<table>` semantics, `font.size.meta` header
row in `text.muted`, `border.subtle` row hairlines, mono tabular numerals for
numeric cells, and no per-surface reinvention of alignment or padding.

## As shipped

Composed (`Table`, `Table.Head`, `Table.Cell`, `Table.Row`) rather than
data-driven. The call sites need `<colgroup>` tracks, per-cell titles, spanning
rows and conditional row paint; a `columns={[…]} rows={[…]}` API would have to
grow an escape hatch for each, and the escape hatches are where the chrome would
drift apart again. What is shared is the chrome — nothing about the data model.

| Part | Contract |
|---|---|
| `Table` | `border-collapse`, `font.size.meta`; `fixed` takes widths from `colgroup` |
| `Table.Head` | `scope="col"`, `text.muted`, medium weight, `border.default` underline |
| `Table.Cell` | `numeric` right-aligns and sets tabular figures |
| `Table.Row` | `border.subtle` hairline |

**Header cells are sticky by default.** Every one of these tables sits in a
scrollport, and a header that scrolls away turns the numbers beneath it into
unlabelled figures. Sticky headers paint `bg.surface` and sit on `z.sticky` —
without a ground, rows show through as they pass under.

**Ruling — tabular figures in the UI face, not the mono family.** The intent
above said "mono tabular numerals". The UI face already has tabular figures, and
switching family mid-row is a louder change than the alignment it buys, in a row
whose labels are UI-face.

**Not migrated: `SprintEngineRosterTable`.** Named in the intent above as a third
variant, but it is a roster *editor* — rows of avatars, CLI pickers and per-role
toggles. `<table>` semantics are wrong for configurable rows, and the rewrite
would be large for no accessibility gain.

**`SprintEngineRunSummaryPanel` keeps its own header classes** deliberately: it
is a dense comparison matrix whose labels carry full words, wrap to two lines and
bottom-align above their numbers. Sharing the table chrome does not mean every
table wears one header.
