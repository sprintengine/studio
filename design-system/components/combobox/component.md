# Combobox

**Status: shipped 2026-08-05** (MC-2117) — `src/renderer/src/components/ui/`.

The filter-as-you-type input over a listbox — for choosing from a set large
enough to search. `Select` is select-only by design, so every filterable case
rebuilt the pattern: five bespoke listboxes ship today (`CliModelPicker`,
`SkillPickerPopover`, `CommandPalette`, `agentComposer/AgentComposerPopover.tsx`,
and `newSprint/NewSprintDialog.tsx`'s own `role="listbox"`), each re-owning
typeahead, active-option state, and keyboard handling. This entry replaces
those with one WAI-ARIA combobox contract on the shared popover surface —
`CommandPalette.tsx` already has the correct ARIA and is the reference
implementation the primitive should share bones with, not duplicate.

## As shipped

The ARIA is `CommandPalette`'s, as intended: **the input is the combobox and
keeps focus throughout**, options are never focused, and the highlighted one is
named by `aria-activedescendant`. That is what lets typing and arrowing work at
the same time — moving real focus onto an option takes it off the field, and the
next keystroke goes nowhere. This is the thing the five bespoke versions each
got differently.

| Key | Behaviour |
|---|---|
| `↑` / `↓` | move the active option, skipping disabled rows |
| `Home` / `End` | jump to the ends |
| `Enter` | commit the active option |
| `Escape` | close the list only — `stopPropagation`, so a dialog hosting a combobox does not close with it |

Options commit on `pointerdown`, not `click`: a click fires after the field has
lost focus, and the blur closes the popup out from under the pointer.

**Ruling — one shape: a trigger opening a surface that carries the field above
the list.** There is deliberately no inline-field variant. `Popover` hands its
trigger a button ref and owns anchoring, flipping, clamping and outside-click; an
inline field would have to either fight that contract or hand-roll an
absolutely-positioned surface — which `lint-panel-composition`'s
`no-bespoke-popover-shell` rule forbids outright. A caller wanting the field to
*be* the control passes a full-width trigger styled as one.

**No picker has adopted it yet.** The five named above each carry behaviour past
filter-plus-listbox — favourites, model families, an inline handle, their own
selection models — so adoption means deciding, per picker, what moves into the
primitive and what stays local. Tracked on MC-2117; rewriting them on assumption
is how a shared primitive collects five escape hatches and stops being shared.
