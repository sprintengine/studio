# Field

The form row: a label, one control, and at most one supporting message,
stacked with a `space.xs` gap. Extracted from the source product's `Field`
wrapper (`src/renderer/src/components/ui/Field.tsx`), which exists so the
wiring — `for`/`id`, `aria-describedby`, `aria-invalid`, `aria-required` —
is written once and cannot be half-done per form.

The `input` entry documents the text control's chrome and uses these same
classes; this entry is the contract for the row itself, whatever control sits
in it: an input, a select, a segmented control, a switch.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Row | `.ds-field` | yes — vertical stack, `space.xs` gap |
| Label | `.ds-field-label` | yes — a real `<label for>` naming the control |
| Required mark | `.ds-field-required` | only on required fields — `*` in `status.danger`, `aria-hidden` |
| Control | — | exactly one focusable control, carrying the `id` the label points at |
| Help | `.ds-field-help` | no — `font.size.meta` in `text.subtle` |
| Error | `.ds-field-error` | no — `font.size.meta` in `status.danger` |

**One supporting message at a time.** Help hides while an error shows — the
control's `aria-describedby` points at exactly one visible message, and two
stacked lines under a control is the screen explaining itself twice. The error
replaces the help because a person fixing a problem does not also need the
tour.

## Variants

- Default — label above the control, as specified.
- Standalone label — `.ds-field-label` on a `<span>`, for the layouts a
  `<label for>` cannot serve: a radiogroup or segmented control (labelled via
  `aria-labelledby`), or a label over a non-control row. Same type, same ink;
  the difference is wiring, not appearance.
- **No horizontal variant.** Label-left/control-right grids belong to settings
  surfaces that compose their own two-column layout; the field itself has one
  shape.

## States

| State | Treatment |
|---|---|
| Rest | Label in `text.default` at `font.weight.medium`; help visible if present |
| Invalid | Control carries `aria-invalid="true"`; error message shown, help hidden |
| Required | `*` after the label (`aria-hidden`) mirrored by `aria-required` on the control |
| Disabled | The control disables itself; the label does not gray out — it still names the thing |

**Empty is not invalid.** A required field nobody has typed in yet shows no
error and no red; the disabled confirm button already says "not yet".
Validation appears after the first keystroke, never on open.

## Usage

- Labels are sentence case, no trailing colon, and name the value ("Folder
  path"), not the interaction ("Enter a folder path").
- Do not label what the dialog title already labels: one field under "New
  horizon" needs no "Horizon name" label — give the control its accessible
  name and let the placeholder do the visible work.
- Help text earns its line only by carrying what the screen cannot show: a
  consequence ("Shown in the sidebar and the switcher"), never a restatement
  of the placeholder or the label.
- Error copy names the problem in a sentence a person can act on ("That folder
  does not exist"), not a validator's classification ("Invalid path").
- One control per field. Two controls under one label are two fields, or one
  composed control that owns its own internals.

## Accessibility

- The label is a real `<label for>` pointing at the control's `id`. For
  grouped controls (radiogroup, segmented control), the standalone label plus
  `aria-labelledby` replaces it.
- `aria-describedby` on the control points at the visible message — the help's
  id or the error's id, whichever is currently shown, never both, never a
  hidden node.
- Invalid state is `aria-invalid="true"` plus the error text naming the
  problem; the red border on the control (see `input`) is the echo, never the
  message.
- The required `*` is `aria-hidden` decoration; `aria-required` on the control
  is what assistive tech hears. Neither appears as an accusation on an
  untouched form — see *Empty is not invalid*.

## Known drift (MC-2114)

- Shipped `Field.tsx` renders the label at 12px (`text-meta`) and the
  help/error messages at 11px (`text-micro`). The system's spec — here and in
  the `input` entry, which shipped first — is label at `font.size.body`,
  messages at `font.size.meta`: supporting copy does not drop below the meta
  step, and 11px is reserved for micro chrome.
- `Modal.tsx` exports a **second** `Field` — label at `text-micro`, hint in
  `text.disabled` ink, no error state, no ARIA wiring at all. It predates the
  real one and survives inside dialogs. It is drift, not a variant: one field
  contract, and a hint in disabled ink fails the rule that `text.disabled`
  never carries actionable copy.
