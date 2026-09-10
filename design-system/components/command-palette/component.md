# Command palette

A scope strip and one field over a grouped result list: the keyboard route to
everything the product can do or open. It is the launcher, not a search screen
— a person opens it, types, presses Enter and it is gone. Extracted from the
shipped `CommandPalette` primitive
(`src/renderer/src/components/ui/CommandPalette.tsx`).

It is a [modal](../modal/component.md) shell in every respect the modal spec
governs — chrome, width step, focus trap, scrim, restore — and it earns the
scrim by the three tests in the principles: the workspace underneath stays the
subject, nothing that names a place leads to it, and it is a task with an end.
What it adds, and what this entry specifies, is the part above the shell: the
**scope strip** that says which question is being asked, the
**combobox-over-listbox** contract, the grouped result anatomy, the row marks,
and the rule that keeps a launcher from turning into a browser. Its ground is the one thing it takes from nowhere else: **glass** —
see Material.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Scrim | `.ds-command-palette-scrim` | yes — full-viewport `overlay.scrim` at `z.modal`, dismissing on a press that both starts and ends on it; a plain tone, never a blur |
| Shell | `.ds-command-palette` | yes — the modal shell's chrome at the `palette` width step (600px, capped `95vw`) on the glass ground, clipping its own corners |
| Band | `.ds-command-palette-band` | yes — the one band of chrome: the strip and the field, one `border.default` hairline beneath |
| Scope strip | `.ds-command-palette-tabs` | yes — a borderless [tabs](../tabs/component.md) strip, `role="tablist"` labelled "Search in": All, then the four narrowings |
| Query row | `.ds-command-palette-query` | yes — `space.lg`/`space.xl` insets, no hairline of its own |
| Leading hint | `.ds-command-palette-hint` | yes — the kit's search glyph in `text.disabled`; it is decoration and says so |
| Input | `.ds-command-palette-input` | yes — `role="combobox"`, transparent, `font.size.heading` |
| Working note | `.ds-command-palette-status` | no — `role="status"`, a line in the list: the word and the liveness working dots, for a search in flight or an install round trip |
| Results | `.ds-command-palette-results` | yes — `role="listbox"` with a required label, height-capped and scrolling |
| Group | `.ds-command-palette-group` | no — `role="group"` with the group's name as its label |
| Group heading | `.ds-command-palette-group-heading` | with a group — the name alone, `font.size.meta` in `text.muted`; no rule, no count; `aria-hidden` |
| Option | `.ds-command-palette-option` | yes — `role="option"`, a stable `id`, `aria-selected` |
| Option mark | `.ds-command-palette-option-mark` | no — a file's kind glyph in its kind's hue, a skill's or plugin's own artwork, an action's glyph, or (`--chip`) a chat's provider chip; `aria-hidden` |
| Option label | `.ds-command-palette-option-label` | yes — truncating; `font.size.heading`, or mono for a line-of-source hit |
| Option detail | `.ds-command-palette-option-detail` | no — the locator under the label, `font.size.micro` in `text.disabled` |
| Shortcut | `.ds-command-palette-shortcut` | no — the command's chord, trailing, a [kbd-chord](../kbd-chord/component.md) capsule |
| Empty | `.ds-command-palette-empty` | no — the one-sentence state when nothing matched |

**The shell is the modal's, not its own — except its ground.** Radius, border,
elevation and width all come from the overlay scale; the palette's local
additions are the glass ground (Material, below) and `overflow: hidden`, so
the band's hairline is clipped by the shell's corners. It keeps its own scrim
only because it sits at **15vh from the top** rather than centred, which no
dialog does — a launcher belongs under the person's hands, not in the middle
of the screen.

**One band of chrome, two lines in it.** The strip and the field share a band
that draws a single hairline, under the field; the strip is the tabs
component's borderless variant, so the active tab's own accent underline is
the only mark between the two lines. A hairline under the strip *and* one
under the field would be the two stacked bands of chrome the principles
reject on sight. Everything else the palette knows is in the list.

## Material

The shell is **glass** (owner ruling 2026-09-10):
`bg.surface-raised` at `glass.opacity` over a `backdrop-filter` of
`glass.blur` and `glass.saturation` — the toast card's recipe — under the
modal's own radius, `border.subtle` hairline and `shadow.modal`. Where
`backdrop-filter` is unsupported the shell is solid `bg.surface-raised`.

The blur ban (principles, "Motion"; the modal and drawer specs) exists
because a blur over a streaming terminal is re-sampled on every PTY chunk,
and a full-viewport scrim doing that was measured at ~10fps. The palette is
allowed what the modal is not for a reason the earlier glass surfaces did not
have: the shipped primitive **holds the terminal repaint pause** for its
lifetime — the same hold `Modal` takes, which stops every pane writing while
a dialog covers the app. Over paused panes the blur is computed once and sits
still, and the area is the shell's, not the viewport's. The **scrim stays a
plain tone**; the ruling is for the shell alone, and the conformance lint pins
the glass utility to the four kit shells that carry it.

## Variants

The scope strip has five tabs, and they **partition** the launcher: every
group is under exactly one of the four narrowings, so the person never has to
wonder which tab a thing is under, and nothing is found twice.

- **All (default)** — every group is searched at once. ⌘K and Shift Shift
  open here.
- **Skills** — every skill and plugin in every configured source, installed
  or not. The terminal's star opens here, and this tab lifts the per-group
  row cap: the tab *is* the person saying they want the whole list.
- **Conversations** — the chats and workspaces the sidebar lists, by title
  and folder.
- **Files** — file names and text in files: Find-in-Path. ⌘⇧F opens here,
  so a snippet of code is never ranked against a command row.
- **Actions** — commands and the create/spawn verbs: what the product can do.

Choosing a tab narrows the same list without reopening the overlay, and focus
returns to the field. Backspace at an empty query steps back to All, so ⌘⇧F's
narrowing and the star's are both reversible without leaving the field for
the strip. A tab, not a chip: the earlier scope token said what the field was
narrowed to but could not offer the other narrowings, and the difficulty it
left — "am I looking for a skill, a chat, or a file, and where did that land"
— is exactly what a strip answers at a glance (owner, 2026-09-10).

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
| Resting (no query, All) | The resting page: **Actions** — the create/spawn/search verbs, each with its glyph and chord — then **Recent conversations**, the chats most recently spoken in, in the sidebar's order, a screen's worth. Not a preview of every group (owner ruling 2026-09-10) |
| Resting (no query, a narrowing) | The tab's groups show a capped preview rather than their full contents |
| Typing | The in-memory groups filter on the keystroke; disk-backed groups debounce and appear beneath the rest |
| Working | The `role="status"` line in the list — "Searching" or "Working" beside the [liveness](../liveness/component.md) working dots. Never beside the query (a note on the field's own line read as part of what was typed), and never a static ellipsis pretending to move |
| Rest (row) | `text.default` — the sidebar's row ink. The heading above it is the quieter one, not the row |
| Active option | `bg.selected` with `text.primary` ink — a cursor, moved by the arrows and by the pointer entering a row, never DOM focus |
| Hover (inactive row) | `bg.hover` and `text.primary`, at `motion.duration.fast` |
| Empty | One line, and it distinguishes *searching* (the working note), *nothing matched*, and *the search failed* — never one "No results" standing in for a failure |

The active row scrolls itself into view (`block: 'nearest'`) as the selection
moves, so a keyboard walk never runs off the bottom of the capped list.

## Usage

**The palette is a launcher, not a destination.** Every row's job is to close
it. There is no multi-select, no inline editing, no detail pane, no state that
survives the dismiss beyond the scope it was opened with.

**Group order is reading order is key order.** The vertical order of the groups
is the order the arrow keys traverse, because a selection that jumps between
sections in an order the eye cannot predict is a list nobody can drive.

**The resting page is a page, not a preview.** With no query on All, the
palette shows what a person opens it for before they have typed: the actions,
then the chats they were most recently in. A resting palette that lists a
sample of every group — six workspaces, six commands, six skills — has
answered a question nobody asked, under headings nobody read. A query searches
every group at once; a narrowing at rest previews its own groups, capped.

**Say which nothing it is.** "No results" is only true once the search that
would have produced them has finished. Populated, empty, loading and error are
four different states here — the principles require a failed dependency to
never render identically to an empty list. What the palette does *not* say is
why a search had nothing to look through ("open a folder to…"): that sentence
told the person about the app's state when they had asked about their query,
and went (owner, 2026-09-10).

**One row, one action.** A row carries a mark, a label, an optional locator,
and an optional chord. No trailing buttons, no per-row menus: the row IS the
action, and a second target inside it is a second thing Enter might mean.

**The mark is the one the thing wears everywhere else.** A file row draws the
file-type glyph the File Explorer and the Git changes list draw for the same
name, in its kind's hue; a skill or plugin row draws its own artwork down the
Extensions door's ladder (glyph → logo → the publishing account's avatar →
monogram); an action draws the glyph its other entry point already wears (the
sidebar's compose mark on New chat, the specialist's icon from the spawn
menu, the search glyph); a chat draws the sidebar's provider chip — the agent
CLI's mark on a round raised ground, or the workspace type's icon when no
agent has run in it. A row that is recognised by its mark before it is read
is what lets a list be scanned, and on the resting page the glyph is what
makes an action row read as an action. A panel or git command wears none:
the verb is the whole row, and a glyph invented for it would be decoration.

**The heading is a word.** `text.muted` at `font.size.meta`, above rows in
`text.default`: the quiet thing is the label and the loud thing is the row.
The rule that filled the line and the count at its end were chrome between
every group and the next, and went (owner, 2026-09-10).

**Rebuilding it in a framework:** what must survive is the combobox/listbox
pairing with `aria-activedescendant` (focus never leaves the field), the
tablist whose panel is the result list, the partition of groups across the
tabs, the fixed group order, the three empty sentences, the height cap with
scroll-into-view, focus returning to the opener on close — and, if the shell
is glass, the terminal repaint hold that makes it affordable.

## Accessibility

- The shell is `role="dialog"` with `aria-modal="true"`, a required
  `aria-label`, and a real **focus trap** — the claim and the behaviour arrive
  together. A modal a keyboard can walk out of is a modal in name only.
- **Focus never leaves the input.** The field is `role="combobox"` with
  `aria-expanded`, `aria-controls` pointing at the list, and
  `aria-activedescendant` naming the active option's `id`. The rows are the
  cursor idiom, not tab stops: Enter acts on the marked row.
- **The field draws no focus ring** (owner ruling 2026-09-10) — the one
  exception to "visible focus, never removed", and a narrow one: the shell
  opens with the caret in the field, the caret is the focus signal, and the
  strip beside it keeps its ring, so a keyboard walk out to the tabs and back
  is still visible at every step. A ring the width of the band read as a
  second box around the only thing on screen.
- **The strip is one tab stop** (the tabs component's roving focus): Tab from
  the field reaches it, the arrows move between scopes, and choosing one
  returns focus to the field. Its `aria-controls` and the combobox's both
  name the result list — the list carries one id per scope, so the tab's
  panel and the combobox's popup are the same element and both references
  resolve. The strip is labelled "Search in".
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

- **A line-of-source label sets at `font.size.meta` (12px)**, under the 13px
  floor the type rules put on primary content — and on a content hit that line
  *is* the primary content. Either the row's identity moves up to
  `font.size.body`, or the floor gains a documented exception for a mono code
  excerpt. Recorded here rather than quietly kept.
- The results cap is a literal `360px`. It is a layout measure rather than a
  token, like the side pane's rails, but it is undocumented in the source.

## Shipped implementation

`src/renderer/src/components/ui/CommandPalette.tsx` — default export, outside
the kit barrel. It composes `OVERLAY_SHELL_CHROME_CLASS` plus the
`surface-glass` utility and `overlayWidthStyle('palette')` from `ui/tokens.ts`
(the shell chrome and the width step this system's
[modal](../modal/component.md) entry defines, with the glass ground in place
of the shell's tone), `Tabs` for the strip, `FileTypeGlyph` and
`ExtensionIcon` for the marks, `KbdChord` for the chords,
`FocusTrap` for the modality claim, `TruncatedText` for both text lines, and
`acquireTerminalRepaintPause` for the hold that makes the glass affordable.
