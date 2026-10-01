# Table

**Status: shipped 2026-08-05** — `src/renderer/src/components/ui/`.

The shared header/row/cell chrome for genuinely tabular data — columns of
values compared across rows, where `list-row` (a pick-an-item list) is the
wrong shape. Three bespoke implementations ship today: hand-rolled `<table>`
markup in `diagnostics/DiagnosticsContent.tsx` and in the markdown renderer's
table block (`utils/markdown.tsx`), plus a third div-grid variant in
`settings/ThirdPartyModuleList.tsx`. This entry replaces all three with one
contract: real `<table>` semantics, `font.size.meta` header
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

**Not migrated: `ThirdPartyModuleList`.** Named in the intent above as a third
variant, but it is a module *editor* — rows of tiles, capability chips and
per-module toggles. `<table>` semantics are wrong for configurable rows, and the
rewrite would be large for no accessibility gain.

**`DiagnosticsContent` keeps one local cell rule** deliberately: every cell is
`whitespace-nowrap`, because a wrapped PID or byte count destroys the column scan
those tables exist for. Sharing the table chrome does not mean a surface gives up
the one thing that is genuinely local to it.

## Usage — a table in rendered markdown

A table an agent writes into a reply, a plan or a document is drawn by the
markdown renderer (`utils/markdown.tsx`) on this same chrome: header rule in
`border.default`, row hairlines in `border.subtle`, no verticals, no header
fill, tabular figures, and GFM column alignment carried to every cell. Three
things differ, each because the table sits in prose rather than in a panel:

- **The header is in strong ink, semibold.** In a panel the header labels
  columns of chrome and steps back; in a reply it is the author's own words and
  reads with the headings around it.
- **In a conversation it is sized to its content and scrolls.** Squeezed to the
  pane, a column breaks an id at every hyphen and a number across two lines. A
  cell wraps only past a cap (a readable line, never most of the pane), a wider
  table scrolls inside the pane, and the edge that hides columns fades so a
  cut-off table does not read as one that ends there. Its outer columns sit
  flush with the prose.
- **A footer copies it whole.** A selection of a table pastes as runs of cells,
  so the table carries the copy glyph (Markdown, with an HTML flavour so a rich
  editor pastes a real table) and a menu beside it for CSV and TSV. The footer
  is `data-copy-exclude` and always visible: two quiet glyphs, and a menu opened
  from it must not vanish with the pointer. A CSV or TSV cell that a
  spreadsheet would run as a formula (one opening with `=`, `+`, `-` or `@`,
  other than a plain signed number) goes out behind a `'`, so it pastes as text.

The conversation's prose around it is one ramp step per rung, not a document's:
body at `heading` (14px, relaxed leading) in `text.default`, headings compressed
to `title` / `heading` / `body`, and headings, `strong` and inline code in
`text.primary` — the contrast between the two inks, not size, is what makes the
important words stand out.
