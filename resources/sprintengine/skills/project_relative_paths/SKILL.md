<what-to-do>

# Project-Relative Paths

Never use absolute or machine-specific file paths in work items, evidence, artifacts, plans, reviews, or handoff text. Full paths break when the repository is opened on another computer.

All file and directory references must be relative to the project root, using forward slashes where practical, for example `src/renderer/src/App.tsx`, `resources/skills/example/SKILL.md`, or `docs/reviews/code-review-1.md`.

App-owned state — Sprint Engine run stores, the backlog cache, automations —
lives under `<sidecar>/`, the workspace's app-owned directory. `<sidecar>` is
`.sprintengine` in a workspace made since the 2026-09-08 rename and
`.multi-code` in an older one; a workspace has exactly one of them and nothing
migrates between the names. Start such a path from the directory that is already
there rather than from a remembered name — creating the other one beside it
orphans the state the app is reading.

</what-to-do>
