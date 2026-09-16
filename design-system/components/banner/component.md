# Banner

The panel-spanning notice: one line at the top of a panel's content region
saying that the panel's own data is failing or degraded, with the recovery
beside it. Extracted from the source product's `Banner`
(`src/renderer/src/components/ui/Banner.tsx`).

A banner is about **this panel's content** — the feed did not load, posting is
paused, the connection dropped. A problem scoped to one section, row, or
operation belongs to an `inline-notice` inside that scope; a transient
confirmation belongs to a toast. And a banner is not chrome: it is a notice
*about* the content, so it keeps its own band below the panel's chrome row
without violating the one-chrome-band rule.

Tone vocabulary — the same two tones as `inline-notice`, and the same
meanings:

- **danger** — a failure. Something did not happen. Always paired with a
  recovery action; a dead-end failure banner is a bug.
- **warn** — degraded but working. Reduced, paused, or partial — never a hard
  failure recolored, and never a failure softened to amber.

There is no info banner and no success banner. Information that matters is the
panel's content; success is the state the screen already shows.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Strip | `.ds-banner` | yes — full width of the panel's content region |
| Body | `.ds-banner-body` | yes — dot + message cluster; shrinks first |
| Dot | `.ds-banner-dot` | yes — the 6px status dot in the tone's hue, `aria-hidden` |
| Message | `.ds-banner-message` | yes — one line, truncates |
| Action | `.ds-banner-action` | danger: required; warn: optional — holds a ghost button (`.ds-button.ds-button--ghost`) |

The strip: the tone's **soft** tint over the surface, a `border.default`
hairline on the bottom edge only (it shares every other edge with the panel),
`space.lg` / `space.sm` padding, message at `font.size.meta` in
`text.primary`.

**No left tone-bar** — the rejected-on-sight rule applies to banners exactly
as it does to notices. The dot is the tone's shape; the tint is its echo.

## Variants

- `ds-banner--danger` — failure. `status.danger` dot on `status.danger-soft`.
- `ds-banner--warn` — degraded. `status.warn` dot on `status.warn-soft`.

Nothing else: no sizes, no icon slots, no dismiss-x variant. A banner leaves
when its condition resolves — a dismissable failure is a failure you are
still having with worse visibility.

## States

| State | Treatment |
|---|---|
| Present | The condition holds. One banner per panel — the worst condition wins |
| Resolved | The banner unmounts. No success flash in its place |

The banner itself has no hover or selection; its one action is the only
interactive part.

## Usage

- Top of the content region, directly under the panel's chrome, full width of
  the column it describes — not the screen, if the panel is one pane of many.
- One line. The message states the condition ("Feed unavailable"), not the
  exception; detail belongs behind the action or in an `inline-notice` at the
  failure site. A banner that needs to wrap is carrying a paragraph that
  belongs elsewhere.
- The action names the recovery, usually "Retry". It is a ghost button — the
  banner's tint is already the emphasis, and a solid button here would compete
  with the view's real primary action.
- The dot is the status idiom, and it is the only one: no additional glyph, no
  tinted pill, no second mark saying the same thing.
- Do not stack banners. Two conditions at once is one banner for the worse
  condition; the other surfaces where it lives.

## Accessibility

- `role="alert"` on danger — a failure interrupts. `role="status"` on warn —
  degradation informs politely. This split is the tone vocabulary made
  audible; do not flatten both to one role.
- The dot is `aria-hidden`: the message carries the meaning in words, so the
  state is never conveyed by color alone — and the two roles differ, so it is
  not conveyed by the dot's shape alone either.
- The action is a real button, reachable by Tab, with the banner's context in
  its accessible name where "Retry" alone is ambiguous ("Retry loading
  sessions").
- Truncated messages still expose their full text (the `list-row`/tooltip
  truncation contract applies).

## The action slot (MC-2115, 2026-08-05)

The anatomy above says the action slot "holds a ghost button" — it did not say
that button has to be spelled *Retry*, and the two strips that were rebuilding
this component by hand both needed to say something else: **Relink** beside the
retry on a Backlog scan whose saved folder went missing, and **Refresh
walkthrough** on a review whose head moved. Shipped `Banner` takes an optional
`action` node for exactly that, rendered after the Retry when both are given.

It is still one recovery cluster, not a toolbar. A condition that wants a third
control is not a banner condition — it belongs in an `inline-notice` at the
site of the failure.

**Ruling — there is no quiet banner.** The review canvas's freshness strip had
invented a third "quiet" tone for the walkthrough being current. A resolved
condition unmounts its banner; what is left when nothing is wrong is a plain
provenance line, not a tinted strip in a calmer colour.

Remaining drift: paddings here are Tailwind steps (`px-3 py-2`) that land on
the scale but bypass the variables.
