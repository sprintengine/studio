# Project-Relative Paths

Never use absolute or machine-specific file paths in task cards, evidence, artifacts, plans, reviews, or handoff text. Full paths break when the repository is opened on another computer.

All file and directory references must be relative to the project root, using forward slashes where practical, for example `src/renderer/src/App.tsx`, `resources/sprintengine/skills/developer/SKILL.md`, or `.multi-code/sprintengine/<team>/reviews/code-review-1.md`.

For Sprint Engine plan, task log, and artifact commands, pass only project-root-relative paths. If a tool prints an absolute path, convert it to a project-relative path before logging or writing it into an artifact.
