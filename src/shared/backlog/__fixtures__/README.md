# Backlog frontmatter fixture corpus

A small, checked-in corpus of backlog item files used as the property-test
fixtures for `../frontmatter.test.ts`. The round-trip properties (set→clear
is byte-identical, writing a field preserves the body and key order) only mean
something against files whose shapes the product actually writes, so these
mirror the real layouts:

- `backlog/epics/example-epic.md` — an epic container with `dependenciesPlanned`.
- `backlog/example-epic/…` — items filed under that epic's folder, one with the full
  current field set (`dependsOn`, `sprints`, `mockups`, `pr`, `updated`), one
  with `dependsOn` deliberately absent so the set-absent→clear inverse is
  exercised.
- `backlog/unfiled/2026-01-07-legacy-nested-section.md` — the legacy nested `backlog:`
  block, which must survive a top-level write untouched.
- `backlog/unfiled/2026-01-08-no-frontmatter.md` — a file with no frontmatter block.
- `backlog/archived/2026-01-09-archived-item.md` — a terminal item with a quoted value
  and a comment line inside the block.

The prose is invented. Only the frontmatter shapes matter; do not treat the
bodies as documentation of anything.
