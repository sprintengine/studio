---
type: epic
status: ready
color: teal
id: 1001
updated: 2026-01-05T09:00:00.000Z
dependenciesPlanned: true
---

# Example epic: make the widget pipeline observable

The widget pipeline runs in three stages and reports nothing between them. When
a stage stalls, the only signal is that the output never arrives, so every
investigation starts by adding logging that is then removed again.

This epic groups the work that makes each stage say what it is doing, in one
vocabulary, so a stall is visible from the outside.

## Out of scope

Rewriting the stages themselves. The ordering is fine; it is the silence that
is the problem.
