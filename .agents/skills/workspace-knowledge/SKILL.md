---
name: workspace-knowledge
description: Read and update a workspace-local Markdown knowledge graph. Use when an agent needs durable project, product, architecture, brand, ecosystem, or decision context from a configured knowledge folder, or when work creates lasting knowledge that should be added back to that knowledge graph.
---

# Workspace Knowledge

The workspace's configured knowledge folder is a shallow Markdown knowledge graph of small linked notes. Agents traverse it from the index, loading only the notes a task needs. Every note is written for agents, not humans: terse, dense, verifiable. The folder is configurable per workspace; do not assume it is named `knowledge` unless runtime context or workspace settings say so.

## Read Workflow

1. Identify the configured knowledge root from runtime context, workspace settings, or user instructions.
2. Start at `<knowledge-root>/README.md`; follow the smallest set of `[[wikilinks]]` relevant to the task.
3. Knowledge is orientation, not implementation truth. Verify behavior in source/tests before making code claims.
4. Do not bulk-read the graph unless the task is explicitly broad.

## Update Workflow

Update when work creates durable knowledge: an architecture boundary, contract, invariant, brand rule, or a non-obvious gotcha that cost time.

- Prefer updating an existing note over creating one; create a new note only for a durable concept with no home.
- Link every new note from `README.md` or the nearest hub note, and cross-link with `[[wikilinks]]` (path form, no `.md`: `[[multicode/sprint-engine]]`).
- Source anchors are repo-relative code spans (`src/main/index.ts`); sibling repos use `../repo/path`.

## Prune On Touch

Any time you open a note to update it, you also own its freshness:

- Delete claims contradicted by code; fix or cut anchors whose files/symbols no longer exist.
- Delete dated status text, changelog-style history, sprint narrations, and roadmap speculation. Git is the changelog; the graph holds only what is currently true.
- Replace duplicated background with a `[[wikilink]]` to the note that owns it.
- Deleting a stale note (and its inbound links) is a normal, good outcome.

## Style

- Bullets, not prose. No marketing language, no "This document describes...", no restating what file names already say. Every line is an actionable fact or a real constraint.
- Default reading of a note is implemented behavior. Mark exceptions explicitly: `Direction (not built):` for intent, `Risk:` for open risks.
- Note shape: `# Title`, one scope line, sections of bullets, `## Related` wikilink list at the end.

## Note Size

- Target ≤ 750 words / 140 lines per note (lint soft warn); hard fail at 1,500 words / 250 lines.
- A note over the hard cap covers more than one concept — split it into linked sub-notes, never rewrap lines to game the count (words are what's measured).
- Check with `npm run lint:knowledge-size` when available. Ceilings were set after a full-graph prune; never raise them.

## Do Not Store

- Secrets, credentials, tokens, session data, or private customer/personal data.
- Task logs, transient debugging notes, speculative guesses, or unverified claims presented as fact.
- Mutable runtime state the code or a live system already owns.

## Completion Check

- Note is within size limits and in bullet style.
- It links to related notes and is reachable from an entry point.
- Anchors are repo-relative and were spot-checked to exist.
- Stale content encountered along the way was pruned, not preserved.
