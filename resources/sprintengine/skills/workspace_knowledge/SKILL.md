# Workspace Knowledge Graph

<what-to-do>

Before anything else in this skill, check the `MULTICODE_KNOWLEDGE_ROOT` environment variable (or the legacy alias `MULTICODE_MEMORY_ROOT`). If neither is set, this workspace has no Knowledge Graph: skip every step below — do not create notes, do not write into a default `knowledge/` folder, and do not stop the task to ask for one. Reviewers must not flag KG drift in unconfigured workspaces.

When either is set, treat its value as the KG root. KG updates are part of acceptance evidence, not follow-up work: when your change touches a documented behavior, contract, file layout, or convention, update the relevant note in the same handoff as the source change and log the note path as file evidence.

</what-to-do>

<supporting-info>

## Read Workflow (when KG is configured)

1. Start with `<kg-root>/README.md` if it exists; otherwise scan the top-level folders for orientation.
2. Read the smallest relevant set of notes for the task — the ones that name the modules, contracts, surfaces, or conventions you are about to touch.
3. Follow `[[wikilinks]]` only when they point at something material to the current change.
4. Treat KG notes as orientation, not implementation truth. Verify current behavior in source files, tests, commands, or runtime state before basing a code claim on a KG note.
5. Do not bulk-read the whole KG. Pull only what you need.

## Update Workflow (when KG is configured)

Update an existing note when your work changes any of:

- A documented behavior, contract, API shape, IPC route, command surface, or data model.
- A file layout, ownership boundary, or naming convention named in the KG.
- An operational rule, brand rule, packaging rule, or process convention named in the KG.
- A decision recorded in the KG that the new work supersedes or refines.

Create a new note only for a durable concept that does not fit an existing page. New notes must be linked from `<kg-root>/README.md`, an ecosystem map, or the most relevant existing note via `[[wikilinks]]`.

## Do Not Store

- Secrets, credentials, tokens, private keys, or session data.
- Private customer data or regulated personal data unless the user has explicitly asked and the repository policy allows it.
- Temporary task logs, speculative guesses, or transient debugging notes.
- Claims that were not verified, or labeled assumptions sold as facts.
- Routine implementation details that do not need to survive the current task.

## Completion Check

Before publishing the task, confirm:

- If a KG is configured and your change touched a documented behavior or convention, the relevant note is updated in the same publish.
- The updated note links to related notes via `[[wikilinks]]`.
- Source paths in the note are project-root-relative.
- The note distinguishes confirmed facts from assumptions.
- You did not turn the KG into a second source of truth for mutable runtime state.

## Reviewer Responsibility

Spec reviewers and code reviewers: when a KG is configured for the workspace and the reviewed change touches a documented behavior, contract, file layout, or convention, the absence of a corresponding KG note update is a blocking finding. Record it like any other acceptance miss. When no KG is configured, do not raise KG-related findings.

</supporting-info>
