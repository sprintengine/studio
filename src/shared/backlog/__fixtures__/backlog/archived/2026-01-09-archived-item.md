---
# the type line was added when the schema gained it
type: bug
status: completed
difficulty: s
criticality: low
id: 1004
title: "Fix: the ordering bug"

updated: 2026-01-09T16:45:00.000Z
---

# The ordering bug

Two widgets with the same timestamp came back in whichever order the map
happened to yield. Sorting by id as the tiebreak makes the order total, which is
all any caller needed.

Kept as a fixture because its frontmatter block carries a comment line, a
quoted value, and a blank line — all three must survive a write untouched.
