---
backlog:
  status: ready
  planKind: architect_plan
---

# Retry budget for the fetch step

The fetch step retries forever, so a permanently unreachable source looks
identical to a slow one. Give it a budget: a fixed number of attempts, then a
terminal failure that names the source.

This file keeps the legacy nested `backlog:` block on purpose — a top-level
write must leave it byte-for-byte alone.
