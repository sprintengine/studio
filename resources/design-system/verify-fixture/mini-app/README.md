# Verify fixture: "Jotter" mini-app

A deliberately tiny sample product used as the "seed from an existing product"
source for the Design Wizard golden-path checklist
(`docs/verify/design-wizard-run.md`, MC-1506). It is **not** the multicode repo:
a small, self-contained fixture keeps the manual run fast and reproducible.

It carries exactly what the design-system seeding flow extracts from:

- `styles.css` — `:root` CSS custom properties (light + dark) the agent infers
  DTCG tokens from, plus one real component (`.jotter-button`).
- `index.html` — a page consuming those custom properties, so the agent has
  markup to read.
- `icon-check.svg` — one glyph, `currentColor`-driven, for the glyph extraction
  path.

Keep it small when refreshing it — a handful of custom properties, one component,
one glyph — so the checklist stays quick to run.
