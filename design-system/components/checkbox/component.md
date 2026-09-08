# Checkbox

**Status: shipped 2026-08-05** (MC-2117) — `src/renderer/src/components/ui/`.

The one-of-a-set form control: a value the person marks now and submits
later. The `switch` entry already draws the line — a switch commits
immediately, a checkbox belongs to a form. Five surfaces had each styled the
same `<input type="checkbox">` independently — 3px and 3.5px boxes, one on the
browser's `accent-color`, one with a hand-rolled ring whose `ring-offset-color`
was pinned to one surface's background and therefore wrong on any other, and
one with no focus treatment at all. The most complete of them — the
styled-peer control that motivated `FOCUS_RING_PEER_CLASS` — is what this
entry promotes: one token-backed control with a `radius.chip` box,
`accent.primary` checked fill, the shared focus ring, and a real `<label>`.
