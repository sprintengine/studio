# Combobox

**Status: planned — not yet shipped.** Built by MC-2117.

The filter-as-you-type input over a listbox — for choosing from a set large
enough to search. `Select` is select-only by design, so every filterable case
rebuilt the pattern: five bespoke listboxes ship today (`CliModelPicker`,
`SkillPickerPopover`, `CommandPalette`, `agentComposer/AgentComposerPopover.tsx`,
and `newSprint/NewSprintDialog.tsx`'s own `role="listbox"`), each re-owning
typeahead, active-option state, and keyboard handling. This entry replaces
those with one WAI-ARIA combobox contract on the shared popover surface —
`CommandPalette.tsx` already has the correct ARIA and is the reference
implementation the primitive should share bones with, not duplicate.
