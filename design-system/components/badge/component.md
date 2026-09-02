# Badge

**Status: shipped 2026-08-05** (MC-2117) — `src/renderer/src/components/ui/`.

The small display-only label or count chip: a tone-carrying word ("draft",
"merged") or a number docked on a row or a control. "Badge" appears across
10+ files today (`BacklogRow`, `WorkspaceActions`, `PanelSwitches`,
`ThirdPartyModuleList`, `AttentionQueuePopover`, …) as ad-hoc rounded spans,
with count-badge styling reinvented per surface. This entry replaces those
with one primitive: `font.size.micro`/`meta` type on `radius.chip`, tones
drawn from the `status.*-soft` fills with their matching ink, never
interactive, and never a second status idiom beside a status dot that already
says the same thing.

## As shipped

Two species under one name, because the audit found two:

| | Shape | Fill | Ink |
|---|---|---|---|
| **Count** | circle at one digit, pill beyond | solid `tone.*` | `text.on-accent` |
| **Label** | pill | `tone.*-soft` with a `tone.*` hairline | `text.muted` |

`tabular-nums` on counts, so 1 → 2 does not jog the row. A `max` caps the
number ("99+") rather than letting the badge widen past its trigger.

**Ruling — radius is `pill`, not `radius.chip`.** The intent above said
`radius.chip` (3px); every badge actually shipping is `rounded-full`, and a
one-digit counter has to be a circle for the docked corner position to read as
a badge rather than a clipped square. `radius.chip` is the right token for a
*rectangular* chip; this is not one.

**Ruling — a count's ink is `text.on-accent`, not `bg.app`.** All three shipped
counters hardcoded `bg.app` as their foreground, which is only legible while the
badge sits on a saturated tone. `text.on-accent` is the token that means
"foreground for a filled surface" and holds on every theme.

**Corner mode** docks the badge to the top-right of a positioned trigger with a
1px border in the surface behind it, so it reads as sitting *on* the control. A
box-shadow ring would hold the box at exactly 16px, but the token lint's
`no-glow-shadow` rule forbids that spelling — and every counter this replaces
already used a border.

Never interactive, and never a second status idiom beside a `status-dot` that
already says the same thing. A badge carrying meaning takes an `ariaLabel` (a
bare "3" tells a screen reader nothing); one that merely repeats adjacent text
is marked `decorative` so it is not read twice.

## Only a count is a live region (2026-09-02)

The two species announce differently, and this is the part a consumer gets
wrong in both directions.

- **Count** — `role="status"`, so a value changing in place beside its trigger
  (the attention bell) is announced. This is what an announcement is *for*: the
  number moved while the reader was elsewhere.
- **Label** — never a live region. `role="img"` when it carries an `ariaLabel`
  (a bare `<span>` has no role for the name to hang on), plain text otherwise.

The audit found the label species emitting `role="status"`, which turned a
hundred-row skill listing into a hundred polite live regions that re-announced
every time the list narrowed. The fix belongs here rather than at the call
sites: marking those chips `decorative` would have silenced them, and
`decorative` means "the adjacent text already says this" — it is not a mute
button. Used as one it hides a fact nothing else states, which the same audit
found at three settings rows whose chip was the only thing saying a module was
unavailable or that a row was a skill rather than a server.
