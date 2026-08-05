# Combobox

**Status: shipped 2026-08-05** (MC-2117) — `src/renderer/src/components/ui/`.
**Keyboard model ruled and adopted 2026-08-06** (MC-2134) — see the ruling below.

The filter-as-you-type input over a listbox — for choosing from a set large
enough to search. `Select` is select-only by design, so every filterable case
rebuilt the pattern, and the rebuilds disagreed about the part that matters least
visually and most functionally: **the keyboard model**. This entry is the one
contract they now share.

## As shipped

The ARIA is `CommandPalette`'s: **the input is the combobox and keeps focus
throughout**, options are never focused, and the highlighted one is named by
`aria-activedescendant`.

| Key | Behaviour |
|---|---|
| `↑` / `↓` | move the highlighted option, skipping disabled rows |
| `Enter` | commit the highlighted option |
| `Escape` | close the list only — `stopPropagation`, so a dialog hosting a combobox does not close with it |
| `Home` / `End` | jump to the ends of the list — **only while the field is empty**, and only where a picker binds them at all; see the ruling |
| `→` | enter the highlighted row's own controls, where it has any — see the ruling |

Options commit on `pointerdown`, not `click`: a click fires after the field has
lost focus, and the blur closes the popup out from under the pointer.

**Ruling — one shape: a trigger opening a surface that carries the field above
the list.** There is deliberately no inline-field variant. `Popover` hands its
trigger a button ref and owns anchoring, flipping, clamping and outside-click; an
inline field would have to either fight that contract or hand-roll an
absolutely-positioned surface — which `lint-panel-composition`'s
`no-bespoke-popover-shell` rule forbids outright. A caller wanting the field to
*be* the control passes a full-width trigger styled as one.

## Ruling — the keyboard model (MC-2134)

Two incompatible models shipped, and both were defensible. **Focus stays in the
field**, highlight named by `aria-activedescendant`. Or **real DOM focus moves
onto the option**, which lets each row hold its own controls, and is what
`CliModelPicker` did so that its favourite star had somewhere to be reached from.

**Ruled: `aria-activedescendant`, always.** Narrowing and walking in one motion is
what a searchable list is *for*; with real focus on the row, every keystroke after
the first arrow goes to the row instead of the query, so you can filter or you can
walk, never both. Adopted in `CliModelPicker` on 2026-08-06 — the only picker that
was on the other model.

**A row may hold its own controls, and must then offer a keyboard path into
them.** The ruling does not shrink what a row can carry; it moves the cost onto
the picker that carries it. With focus pinned to the field, a row-level control is
unreachable unless the picker gives it a key: `→` (ArrowRight) moves real focus
into the highlighted row's control — `←` returns to the field, and Escape still
closes the surface from anywhere inside it. Both call sites with row-level
controls implement it: `CliModelPicker`'s favourite star, and
`AgentComposerPopover`'s per-row engine chip, which before the ruling was a
`tabIndex={-1}` span no key could reach at all.

**Keys the caret has a claim on reach the list only when the caret cannot use
them.** `↑`/`↓`/`Enter`/`Escape` are unconditionally the list's — a single-line
field has no use for them. `Home`/`End` are the caret's whenever the field has
text: a filter you cannot reach the end of the query in is worse than one you
cannot jump the list in. A picker MAY give them to the list while the field is
empty (`ui/Combobox`, `CliModelPicker` and `AgentComposerPopover` do;
`CommandPalette` leaves them to the caret always, which is the same prohibition
observed more strictly). `→` only leaves the caret when the caret is already at
the end of the query.

The prohibition is the ruled part. Which of the optional halves a picker takes is
its own call — what no picker may do is take a key the caret is currently using.

**A row-level control that a pointer reveals must also be revealed by the
keyboard highlight.** `CliModelPicker`'s star appears on hover; it now appears on
the highlighted row too, because `→` is otherwise an affordance only a mouse user
could discover.

**The highlight and the current value are two different marks.** Where a picker
has both — a persistent chosen value AND a moving highlight — the highlight uses
`--bg-hover` (what `Select` gives its own active option) and the current value
keeps the stronger `--bg-selected` fill. Never the focus ring: that belongs to the
field, which is the thing actually holding focus.

## Conformance, measured 2026-08-06

| Picker | Verdict |
|---|---|
| `CommandPalette` | conformant — the reference the primitive was built from; binds no `Home`/`End`, so the caret always keeps them |
| `ui/Combobox` | conformant — the primitive; `Home`/`End` made caret-aware by this ruling |
| `AgentComposerPopover` | conformant — gained `→` into its row engine chip, caret-aware `Home`/`End`, and an Escape that peels the flyout rather than the picker |
| `CliModelPicker` | conformant — **migrated** off DOM-focus roving to `aria-activedescendant` |
| `SkillPickerPopover` | **not a combobox.** `role="menu"` with `menuitem` rows and a filter field. Picking a skill to insert chooses an *action*, not a value — the shape `components/menu` already specifies. Struck from MC-2117's list rather than migrated. |
| `newSprint/NewSprintDialog` | **not a combobox.** A multi-selectable listbox with an external filter: rows toggle rather than commit, `aria-multiselectable` is not a property a combobox may carry, the list is permanently rendered and is its own tab stop running its own cursor, and `Space` (the toggle) cannot coexist with a field that owns focus. Given the link that DOES fit that shape — the field naming the list through `aria-controls` (`ui/InboxSearchInput`'s `controlsId`). |

## Adoption is the contract, not the chrome

Four of the six surfaces above are comboboxes. Three of those are call sites, and
none of the three renders its rows through the primitive — `ui/Combobox` still
has no consumer, which is the honest state and a deliberate one. Each carries
behaviour past
filter-plus-listbox — favourites and model families (`CliModelPicker`), per-row
engine editors and specialist sections (`AgentComposerPopover`), grouped results
with keybinding hints (`CommandPalette`) — and growing `Combobox` an escape hatch
per picker is how a shared primitive stops being shared. What they share is the
keyboard model above; `ui/Combobox` is for the cases that are genuinely a filter
over a flat list.
