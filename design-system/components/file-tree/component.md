# File tree

A folder of files, as a tree: one 24px row per entry, indented by depth, a
disclosure chevron on folders, a 16px glyph slot, the name in its git tint and
a one-letter status. It is the Files tab in the workspace pane and the column
beside the file in the editor window — the same rows in both, because two
trees that drew their own rows would be two answers to "how far does a child
indent" and "what does the selected row look like".

What a tree lets you **do** with a row is the surface's decision, not the
row's. The workspace tree renames, moves, drags and deletes; the editor
window's tree only reads and opens. Neither changes how a row looks.

**Why not `check-row --tree`.** [check-row](../check-row/component.md) is the
pick-_and_-mark row: it spends its fifth element on a checkbox, because in the
Git changes list the tick is the index. A file tree marks nothing — picking a
row is the whole interaction — so it has no box, and its rows can stay at four
elements (chevron, glyph, name, status) under the ceiling without an amendment.

In the app: `FileTreeRow`, `FileTreeRootRow`, `FileTreePinnedRow` and
`FileTreeRows` in `src/renderer/src/components/ui/FileTree.tsx`.

## Anatomy

| Part       | Class                      | Required                                                                                            |
| ---------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| Tree       | `.ds-file-tree`            | yes — `role="tree"`, one tab stop, `aria-label` naming the root                                     |
| Band       | `.ds-file-tree-band`       | no — the chrome row over a tree with no root row: the root's name, then the filter and collapse-all |
| Band title | `.ds-file-tree-band-title` | with the band — folder glyph and the root's name; the full path is its tooltip                      |
| Row        | `.ds-file-tree-row`        | yes — `role="treeitem"`, `aria-level`, `aria-selected`, `aria-expanded` on folders                  |
| Depth      | `--ds-file-tree-depth`     | yes — a unitless level; one level is `space.lg + space.3xs`, the chevron's advance plus a hair      |
| Twisty     | `.ds-file-tree-twisty`     | yes — the chevron; `--leaf` on a file keeps the slot and drops the mark                             |
| Glyph      | `.ds-file-tree-glyph`      | yes — the reserved 16px slot: the file's kind glyph, or the folder glyph                            |
| Name       | `.ds-file-tree-name`       | yes — truncates from the end; tinted by git status (`--modified`, `--added`, `--deleted`)           |
| Badge      | `.ds-file-tree-badge`      | no — display-only status letter: `A`, `M`, `R`, `D`, `!`                                            |
| Pinned     | `.ds-file-tree-pinned`     | no — the open file when it lies outside the root (below)                                            |

## Variants

- **Rooted** — the workspace pane's tree: the first row is the root folder
  itself, name strong and path muted, and its chevron folds the whole tree.
  Depth 0 sits one level in from it.
- **Banded** — the editor window's tree: a band names the root and carries
  the view controls, and the first level of the tree is depth 0 with no row
  above it. The band is the root row's job done once, as chrome.
- **Changed files** — a view of the banded tree, not a separate component:
  only the files git reports as changed, with the folders between them and
  the root synthesised from their paths. Nothing is read from disk to show
  it.
- `.ds-file-tree-row--folder` — a folder's name is set at `font.weight.medium`.
- `.ds-file-tree-row--ignored` — a path the repository ignores: the whole row,
  glyph included, drops to `text.disabled`.

## States

| State                      | Treatment                                                  |
| -------------------------- | ---------------------------------------------------------- |
| Rest                       | `text.default`; the glyph in its kind hue                  |
| Hover                      | `bg.hover`, name to `text.primary` — background only       |
| Selected (tree has focus)  | `--selected`: `bg.selected` plus the 2px inset edge        |
| Selected (focus elsewhere) | `--resting`: `bg.selected-resting`, no edge                |
| Multi-select companion     | `--resting` — the cursor row alone is `--selected`         |
| Expanded                   | chevron rotated 90°; `aria-expanded="true"`                |
| Drop target                | `bg.selected` plus a 1px accent ring (workspace tree only) |

The two selection tiers are `patterns/selection` exactly. In the editor
window the open file's row is selected; while Monaco has the keyboard it
rests, and it takes the full fill and the edge only when the tree itself is
being driven. Exactly one edge is ever on screen.

### Outside the root

When the open file is not under the tree's root — an agent's patch written to
a scratch folder, a file in the home directory — the tree cannot show it, and
saying nothing would leave the person exactly as lost as before. It shows one
**pinned** row above the tree, for as long as that file is the open one: a
caption, _Outside this workspace_ (`.ds-file-tree-pinned-label`), over one row
holding the file's glyph and the folder it is in (`.ds-file-tree-pinned-dir`),
truncated from the start so the folder nearest the file stays in view. The
label is a caption rather than a word in the row because at the column's
default width the row belongs to the folder — the part that says where the
file is. The row is selected, because it is the open file. Its menu (the trailing overflow
button and the right-click) has two items: _Reveal in Finder_ (_Show in
Explorer_ on Windows, _Show in file manager_ elsewhere) and _Copy path_.

## Usage

**Every row is exactly 24px.** `size.hit-target-min`, reached through the
vertical padding — the glyph slot stays 16px so the chevron, folder and file
marks line up with every rail in the app. Nothing a row holds may make it
taller; the rename field that replaces a name is 20px for that reason. The
fixed pitch is also what lets a folder past a thousand rows be windowed by
arithmetic instead of measurement.

**Colour has three channels, one each.** The glyph's hue is the file's kind;
the name's tint is its git status; the row's ink is whether it is ignored.
Selection lifts the fill and the ink, and removes any wash, but never repaints
the glyph or the status tint.

**A reveal lists only the ancestors.** Following the open file expands exactly
the folders between the root and the file, reading only the ones not already
read, then selects the row and scrolls it to the nearest edge. It never scans
the tree, and a tab switch that lands before the last one finished cancels it.

**The tree that only reads writes nothing shared.** The editor window's tree
keeps its own expanded folders, and its column's width and visibility live in
that window's own storage — never in the workspace's remembered state, which
belongs to the workspace tree.

**Rebuilding it in a framework:** what must survive is the fixed 24px pitch,
the one glyph column (the leaf keeps the chevron's slot), the three colour
channels, the two selection tiers, and the one-tab-stop keyboard contract.

## Accessibility

- The tree is **one tab stop**. ↑/↓ move the selection, Home/End jump to the
  ends, → opens a folder (or steps into it when open), ← closes it (or steps
  to its parent), Enter opens a file or toggles a folder.
- **Escape returns focus to the editor** in the editor window, and must not
  reach the window's own Escape (which closes it).
- Every row carries `aria-level`; folders carry `aria-expanded`; the selected
  row carries `aria-selected="true"`. The chevron is `tabindex="-1"` — the
  keyboard reaches folders through the tree, not through the chevron.
- The status letter is display-only and duplicated in the name's tint; it is
  never the only carrier of the state.
- The pinned row names itself in full — file, _outside this workspace_, and
  the folder — since its visible folder may be truncated.
