---
name: workspace-knowledge
description: Read and update a workspace-local Markdown knowledge graph. Use when Codex needs durable project, product, architecture, brand, ecosystem, or decision context from a configured knowledge folder, or when work creates lasting knowledge that should be added back to that knowledge graph.
---

# Workspace Knowledge

Use the workspace's configured knowledge folder as a shallow Markdown knowledge graph for durable context. The folder is configurable per workspace; do not assume it is named `knowledge` unless the current runtime context or workspace settings say so.

## Read Workflow

1. Identify the configured knowledge root from runtime context, workspace settings, or user-provided instructions.
2. Start with `<configured-knowledge-root>/README.md` when it exists.
3. Follow relevant `[[wikilinks]]` before making assumptions about product, architecture, brand, ecosystem, or prior decisions.
4. Treat knowledge as orientation, not implementation truth. Verify current behavior in source files, tests, docs, commands, or runtime state before making code claims.
5. Prefer the smallest relevant set of notes. Do not bulk-read the whole graph unless the task is explicitly broad.

## Update Workflow

Update knowledge when the work creates durable knowledge that should survive the current task, such as an architecture decision, product boundary, integration contract, brand rule, packaging rule, or operational convention.

- Prefer updating an existing note over creating a duplicate.
- Create a new note only for a durable concept that does not fit an existing page.
- Link new notes from an entry point such as `<configured-knowledge-root>/README.md`, an ecosystem map, or the most relevant product note.
- Use Obsidian-style `[[wikilinks]]` for related knowledge notes.
- Keep notes concise, factual, and navigable.
- Use project-root-relative source paths such as `src/main/index.ts`.

## Note Size

Keep notes small so agents can traverse the graph from the index without loading large files.

- Aim for ≤ 1,500 words (~2k tokens) per note.
- Split any note over 5,000 words or 800 lines — it covers more than one concept; link the new sub-notes from an entry point and each other.
- Measure words, not lines; line counts are gameable by rewrapping.
- Check with the project's knowledge-size lint script when available.

## Do Not Store

- Secrets, credentials, tokens, private keys, or session data.
- Private customer data or regulated personal data unless the user explicitly asks and the repository policy allows it.
- Temporary task logs, speculative guesses, or transient debugging notes.
- Claims that were not verified or clearly labeled as assumptions.

## Completion Check

Before finishing a knowledge update, confirm that:

- The updated note links to related notes.
- Any source paths are project-root-relative.
- The note distinguishes confirmed facts from assumptions or ideas.
- The change does not make knowledge a second source of truth for mutable runtime state.
