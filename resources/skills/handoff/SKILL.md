---
name: handoff
description: Create a concise continuation handoff for another agent or future session. Use when pausing work, transferring context, summarizing an unfinished investigation, preparing a Sprint Engine or Switchboard continuation, or preserving next steps without duplicating existing artifacts.
---

# Handoff

Write a handoff that lets a fresh agent continue without replaying the whole conversation.

## Gather

Reference existing artifacts instead of duplicating them:

- Sprint Engine state, task ids, plan artifacts, evidence, and review files.
- Switchboard inbox or task ids.
- Knowledge Graph notes.
- Future plans, PRDs, docs, diffs, tests, or command output.

Use project-root-relative paths. Do not include secrets, credentials, private customer data, or transient speculation.

## Structure

Use this shape:

```md
# Handoff

## Goal
What the user is trying to accomplish.

## Current State
What is done, what changed, and where to look.

## Key Context
Confirmed facts, decisions, constraints, and relevant artifact paths.

## Next Steps
Ordered actions with expected verification.

## Open Questions Or Blockers
Anything that needs user or maintainer input.

## Suggested Skills
Skills a future agent should use, if any.
```

## Rules

- Keep it concise and specific.
- Link paths instead of pasting long content from existing artifacts.
- Include verification commands already run and their result.
- Make clear whether the worktree contains uncommitted changes.
- Do not claim completion for work that is only planned or prototype-only.

If the user gives a target path, write there. Otherwise, provide the handoff in the response or use the repo's established handoff/artifact location when one exists.
