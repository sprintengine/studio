# Truncated text

Text that ellipsis-truncates in a constrained box and restates itself in a
tooltip **only when it is actually cut off**. Extracted from the shipped
`TruncatedText` primitive
(`src/renderer/src/components/ui/TruncatedText.tsx`).

This component is the enforcement of the tooltip's restate-only-when-cut-off
rule (see `components/tooltip`): a tooltip repeating a title the person can
already read is noise, so the tooltip attaches only while the text
overflows. It is the default treatment for every title, label, and path in a
width-constrained slot — `panel-header` titles, `board-lane` labels, row
titles.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Text | `.ds-truncated-text` | yes — applied to the real element: a `<span>`, `<p>`, or the actual `<h2>` |

One part. The tooltip, when earned, is the system `tooltip` component — this
entry adds no surface of its own.

## Variants

- **Default** — single line: `nowrap`, hidden overflow, ellipsis. Overflow
  is measured by width (`scrollWidth > clientWidth`).
- **`--multiline`** — a line clamp for blurbs and descriptions:
  `--ds-truncated-lines` (default 2) sets the count, and overflow is
  measured by height (`scrollHeight > clientHeight`) so the tooltip appears
  only when the clamp actually hides a line.

## States

| State | Treatment |
|---|---|
| Fits | Plain text. No tooltip, no `aria-describedby`, no cursor change |
| Clipped | Ellipsis, and the tooltip contract attaches: shown on hover after the pointer delay, immediately on `:focus-visible` of the trigger |

The two states are visually identical up to the ellipsis — being clipped is
not an error and gets no tint or underline.

## Usage

**Measure, never assume.** Attach the tooltip from a real overflow
measurement, with a +1px tolerance so sub-pixel rounding cannot report a
false overflow. Re-measure when the text changes and when anything resizes —
the element, its container, or the window. A truncation state computed once
at mount is wrong after the first pane resize.

**The ellipsis needs a shrinkable box.** In flex layouts the element (or its
wrapper) needs `min-width: 0` — without it the flex item refuses to shrink
and the ellipsis never triggers. This is the single most common way the
component silently fails.

**Keep the element's semantics.** Apply the class to the real element — the
`<h2>` stays an `<h2>`, and an `id` referenced by `aria-labelledby`
elsewhere stays on it. Truncation is a paint decision and must not restructure
the document.

**The tooltip restates, it does not add.** The tooltip content is the full
text, verbatim. A *description* the row has no room for is a different job
with a different rule: it must stay reachable without hovering (detail pane,
menu), per the tooltip contract.

**Clamp lines, not height.** The multiline variant clamps to a line count.
Cutting at a pixel height slices a line in half and hides whether anything
was hidden.

## Accessibility

- The full text stays in the document — truncation is visual
  (`text-overflow`), so screen readers read the whole value with no tooltip
  needed. The tooltip serves sighted pointer and keyboard users.
- When the tooltip is attached, the trigger follows the tooltip contract:
  `aria-describedby` only while shown, Escape and scroll dismiss.
- A clipped value on a non-interactive, non-focusable element is invisible
  to keyboard users — the tooltip's hover path is the only path. Fine for a
  value that also lives in the detail pane; otherwise put the truncated text
  on or inside a focusable element.
- Never swap the full text into the accessible name conditionally — the
  name is always the full text, clipped or not.

## Known drift

- ~~The shipped `Tooltip.tsx` that `TruncatedText.tsx` attaches mounts one
  tooltip instance per trigger, where the tooltip spec's contract is one
  surface per document repositioned per trigger.~~ **Not drift — struck
  2026-09-02.** [tooltip](../tooltip/component.md) re-ruled this itself in
  The code won, and "one surface per document, positioned by custom
  properties" was an implementation the spec had no business prescribing. What
  matters is the property — a 200-row list must not put 200 surfaces in the
  document — and a portal created on open and torn down on close satisfies it.
  This entry outlived the contract it cited, leaving two specs in one bundle
  disagreeing about the same component.
