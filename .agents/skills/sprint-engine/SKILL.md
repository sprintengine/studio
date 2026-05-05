---
name: sprint-engine
description: Use Sprint Engine as the canonical local execution authority for read/status/report access to specialist runs, with SprintEngine compatibility for Milestone 01 mutations.
---

Use Sprint Engine when an agent needs canonical execution run, task, artifact, role, event, or report data.

## Command Form

Inspect help before first use in a session:

- Windows PowerShell: `& ".\.venv\Scripts\python.exe" ".\scripts\sprintengine_tool.py" --help`
- POSIX shells: `.venv/bin/python scripts/sprintengine_tool.py --help`

If the repository virtual environment is unavailable, use the project Python convention already established in the repo. Do not install Python packages globally.

Use `--repo-root <path>` only when inspecting a repository other than the current working directory.

## Read Commands

Milestone 01 supports these Sprint Engine commands:

```bash
scripts/sprintengine_tool.py run list
scripts/sprintengine_tool.py run status sprint:<team-slug>
scripts/sprintengine_tool.py run inspect sprint:<team-slug>
scripts/sprintengine_tool.py task list --run sprint:<team-slug>
scripts/sprintengine_tool.py artifact list --run sprint:<team-slug>
scripts/sprintengine_tool.py report export --run sprint:<team-slug> --format json
```

Run ids currently use `sprint:<team-slug>` for state files under `.multi-code/sprintengine/<team-slug>/state.yaml`.

## Execution Authority

Treat Sprint Engine schema output as canonical for execution objects:

- run
- task
- artifact
- agent
- event
- evidence/report
- specialist role
- auto-run state

Role prompts come from `specialist-prompts`. Do not use `multiloop-agent-souls` or Multiloop commands for Sprint Engine execution.

## Milestone 01 Write Limit

Sprint Engine mutation commands are intentionally unavailable in Milestone 01. If a task requires claim, status, evidence, notes, artifact review, or plan mutation, use the SprintEngine compatibility tool for that mutation:

- Windows PowerShell: `.\scripts\sprintengine.cmd <args>`
- POSIX shells: `sprintengine <args>` or the repo Python fallback

Do not edit `.multi-code/sprintengine/<team>/state.yaml` directly.

## Path Discipline

Use project-root-relative paths in examples, evidence, artifacts, reports, and handoffs:

```text
docs/sprintengine-cli.md
sprintengine_core/cli.py
.multi-code/sprintengine/01-shared-domain-cli-readonly/state.yaml
specialist-prompts/developer-prompt.md
```

Convert absolute tool output to project-relative paths before writing it into task logs or artifacts.
