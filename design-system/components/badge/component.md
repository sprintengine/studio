# Badge

**Status: planned — not yet shipped.** Built by MC-2117.

The small display-only label or count chip: a tone-carrying word ("draft",
"merged") or a number docked on a row or a control. "Badge" appears across
10+ files today (`BacklogRow`, `WorkspaceActions`, `PanelSwitches`,
`ThirdPartyModuleList`, `AttentionQueuePopover`, …) as ad-hoc rounded spans,
with count-badge styling reinvented per surface. This entry replaces those
with one primitive: `font.size.micro`/`meta` type on `radius.chip`, tones
drawn from the `status.*-soft` fills with their matching ink, never
interactive, and never a second status idiom beside a status dot that already
says the same thing.
