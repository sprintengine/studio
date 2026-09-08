# Command palette

One field over a grouped result list: the keyboard route to everything the
product can do or open. It is the launcher, not a search screen — a person
opens it, types, presses Enter and it is gone. Extracted from the shipped
`CommandPalette` primitive
(`src/renderer/src/components/ui/CommandPalette.tsx`).

It is a [modal](../modal/component.md) shell in every respect the modal spec
governs — chrome, width step, focus trap, scrim, restore — and it earns the
scrim by the three tests in the principles: the workspace underneath stays the
subject, nothing that names a place leads to it, and it is a task with an end.
What it adds, and what this entry specifies, is the part above the shell: the
**combobox-over-listbox** contract, the grouped result anatomy, and the rule
that keeps a launcher from turning into a browser.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Scrim | `.ds-command-palette-scrim` | yes — full-viewport `overlay.scrim` at `z.modal`, dismissing on a press that both starts and ends on it |
| Shell | `.ds-command-palette` | yes — the modal shell's chrome at the `palette` width step (600px, capped `95vw`), clipping its own corners |
| Query row | `.ds-command-palette-query` | yes — one band, `space.lg`/`space.xl` insets, one `border.default` hairline beneath |
| Leading hint | `.ds-command-palette-hint` | yes, when no scope — the `⌘` mark in `text.disabled`; it is decoration and says so |
| Scope token | `.ds-command-palette-scope` | no — the removable chip naming the narrowing, `radius.chip` on `bg.surface-raised` |
| Input | `.ds-command-palette-input` | yes — `role="combobox"`, transparent, `font.size.heading` |
| Working note | `.ds-command-palette-status` | no — `role="status"`, for the one part of the search that is not instant |
| Results | `.ds-command-palette-results` | yes — `role="listbox"` with a required label, height-capped and scrolling |
| Group | `.ds-command-palette-group` | no — `role="group"` with the group's name as its label |
| Group heading | `.ds-command-palette-group-heading` | with a group — name, a `border.subtle` rule filling the line, and a tabular count; `aria-hidden` |
| Option | `.ds-command-palette-option` | yes — `role="option"`, a stable `id`, `aria-selected` |
| Option label | `.ds-command-palette-option-label` | yes — truncating; `font.size.heading`, or mono for a line-of-source hit |
| Option detail | `.ds-command-palette-option-detail` | no — the locator under the label, `font.size.micro` in `text.disabled` |
| Shortcut | `.ds-command-palette-shortcut` | no — the command's chord, trailing |
| Empty | `.ds-command-palette-empty` | no — the one-sentence state when nothing matched |

**The shell is the modal's, not its own.** Radius, border, ground, elevation
and width all come from the overlay scale; the palette's one local addition is
`overflow: hidden`, so the query row's hairline is clipped by the shell's
corners. It keeps its own scrim only because it sits at **15vh from the top**
rather than centred, which no dialog does — a launcher belongs under the
person's hands, not in the middle of the screen.

**The query row is the only chrome.** No toolbar, no tabs, no filter strip:
narrowing is a token inside the field, and everything else the palette knows is
in the list.

## Variants

- **Scope: all (default)** — every group is searched at once, and the leading
  slot holds the `⌘` hint.
- **Scope: files** — the palette opens narrowed, and the hint is replaced by a
  removable token reading the scope's name. The token is a **chip, not a
  tab**: it says what the field is narrowed to and clicking it widens back to
  the full launcher without reopening the overlay. Backspace at an empty query
  pops it, exactly as it pops a chip in a token field, so the narrowing is
  reversible from the keyboard.
- **Groups** are a fixed, ordered set, and the order on screen is the order the
  arrow keys traverse. A group with no matches is not rendered — an empty
  heading groups nothing.
- **The line-of-source option** is the one row that inverts label and detail:
  the matched line is the identity (mono, `font.size.meta`) and the
  `path:line` beneath it is the locator. Everywhere else the name is the label
  and the path is the detail.

## States

| State | Treatment |
|---|---|
| Resting (no query) | Each group shows a capped preview rather than its full contents — the first frame is scannable, not a dump of every command |
| Typing | The in-memory groups filter on the keystroke; disk-backed groups debounce and appear beneath the rest |
| Working | The `role="status"` note in the query row. It is the only part that can be slow, so it is the only part that says it is working |
| Active option | `bg.selected` with `text.primary` ink — a cursor, moved by the arrows and by the pointer entering a row, never DOM focus |
| Hover (inactive row) | `bg.hover` and `text.primary`, at `motion.duration.fast` |
| Empty | One sentence, and it distinguishes *searching*, *nothing matched*, *nothing to search yet*, and *the search failed* — four states, four sentences, never one "No results" standing in for all of them |

The active row scrolls itself into view (`block: 'nearest'`) as the selection
moves, so a keyboard walk never runs off the bottom of the capped list.

## Usage

**The palette is a launcher, not a destination.** Every row's job is to close
it. There is no multi-select, no inline editing, no detail pane, no state that
survives the dismiss beyond the scope it was opened with.

**Group order is reading order is key order.** The vertical order of the groups
is the order the arrow keys traverse, because a selection that jumps between
sections in an order the eye cannot predict is a list nobody can drive.

**Preview at rest, everything on a query.** With no query each group is capped;
a query searches every group at once. A resting palette that lists all several
hundred commands has answered a question nobody asked.

**Say which nothing it is.** "No results" is only true once the search that
would have produced them has finished, and only meaningful when there was
something to search. Populated, empty, loading, error and *unavailable* are
five different sentences here — the principles require a failed dependency to
never render identically to an empty list.

**One row, one action.** A row carries a label, an optional locator, and an
optional chord. No trailing buttons, no per-row menus: the row IS the action,
and a second target inside it is a second thing Enter might mean.

**Rebuilding it in a framework:** what must survive is the combobox/listbox
pairing with `aria-activedescendant` (focus never leaves the field), the fixed
group order, the four empty sentences, the height cap with scroll-into-view,
and focus returning to the opener on close.

## Accessibility

- The shell is `role="dialog"` with `aria-modal="true"`, a required
  `aria-label`, and a real **focus trap** — the claim and the behaviour arrive
  together. A modal a keyboard can walk out of is a modal in name only.
- **Focus never leaves the input.** The field is `role="combobox"` with
  `aria-expanded`, `aria-controls` pointing at the list, and
  `aria-activedescendant` naming the active option's `id`. The rows are the
  cursor idiom, not tab stops: one tab stop, and Enter acts on the marked row.
- The list carries `role="listbox"` and its own label; each group carries
  `role="group"` and the group's name, which is what makes the visual heading
  safe to mark `aria-hidden` — the name reaches a screen reader through the
  group, not through the divider line.
- The input's `aria-label` is a full sentence naming what is searched, and it
  changes with the scope. The placeholder is not the label.
- The working note is `role="status"` (polite): it reports progress without
  interrupting typing.
- Opening focuses the field; closing returns focus to the element that opened
  the palette, so a keyboard user lands back where they were.
- Escape closes — and only when nothing inside has already handled it, so a
  menu or popover opened from within the palette consumes its own Escape
  first. One press, one layer.
- The scrim dismisses on a press that **starts** on it. A drag that began
  inside the field and was released over the scrim is a text selection, not a
  dismissal.

## Known drift

- **The shortcut chip is hand-rolled.** The trailing chord renders as a bare
  `<kbd>` with a local fill and a `rounded` utility that lands on none of the
  3 / 7 / 9 radius steps, while [kbd-chord](../kbd-chord/component.md) is the
  system's mark for exactly this. The CSS here spells the chord the kbd-chord
  way; the primitive should consume that component.
- **A line-of-source label sets at `font.size.meta` (12px)**, under the 13px
  floor the type rules put on primary content — and on a content hit that line
  *is* the primary content. Either the row's identity moves up to
  `font.size.body`, or the floor gains a documented exception for a mono code
  excerpt. Recorded here rather than quietly kept.
- **The group heading's count is invisible to a screen reader.** Marking the
  whole heading `aria-hidden` is right for the rule and the label (both are
  restated by the group's own name), but it also hides the count, which nothing
  else states. The count belongs on the group's accessible name.
- The results cap is a literal `360px`. It is a layout measure rather than a
  token, like the side pane's rails, but it is undocumented in the source.

## Shipped implementation

`src/renderer/src/components/ui/CommandPalette.tsx` — default export, outside
the kit barrel. It composes `OVERLAY_SHELL_CLASS` and
`overlayWidthStyle('palette')` from `ui/tokens.ts` (the shell chrome and the
width step this system's [modal](../modal/component.md) entry defines),
`FocusTrap` for the modality claim, and `TruncatedText` for both text lines.
