# Sprint Engine CLI

Sprint Engine is the local execution authority for specialist runs. Milestone 01 exposes current `swarm/<team>/state.yaml` runs through a deterministic, headless, read-only CLI while keeping existing Swarm write workflows compatible.

Use the repository virtual environment on Windows:

```powershell
& .\.venv\Scripts\python.exe .\scripts\sprintengine_tool.py --help
```

On POSIX shells:

```bash
.venv/bin/python scripts/sprintengine_tool.py --help
```

The CLI prints JSON by default and accepts `--repo-root <path>` when inspecting a repository other than the current working directory.

## Command Surface

Milestone 01 supports read, status, and report commands:

```bash
scripts/sprintengine_tool.py run list
scripts/sprintengine_tool.py run status sprint:01-shared-domain-cli-readonly
scripts/sprintengine_tool.py run inspect sprint:01-shared-domain-cli-readonly
scripts/sprintengine_tool.py task list --run sprint:01-shared-domain-cli-readonly
scripts/sprintengine_tool.py artifact list --run sprint:01-shared-domain-cli-readonly
scripts/sprintengine_tool.py report export --run sprint:01-shared-domain-cli-readonly --format json
```

Inspect help before first use and whenever scripting against a command:

```bash
scripts/sprintengine_tool.py run --help
scripts/sprintengine_tool.py task list --help
scripts/sprintengine_tool.py report export --help
```

Unsupported write-like Sprint Engine commands such as `task claim`, `task status`, `artifact add`, `artifact approve`, `run create`, and `plan` return a nonzero error that states Milestone 01 is read-only. Existing Swarm mutation commands remain available through `scripts/swarm_tool.py` for compatibility.

## Run Ids

Sprint Engine discovers current Swarm team state files as runs. A state file at:

```text
swarm/01-shared-domain-cli-readonly/state.yaml
```

is exposed as:

```text
sprint:01-shared-domain-cli-readonly
```

The current run id format is `sprint:<team-slug>`. The directory layout is not renamed in Milestone 01.

## Canonical Schema

The canonical schema is documented in `docs/sprintengine-schema.md` and implemented in `sprintengine_core/schema.py`.

Top-level state contains:

- `run`: run id, name, goal, status, updated timestamp, and source metadata.
- `tasks`: execution units with role, status, owner, dependencies, owned paths, acceptance criteria, implementation notes, evidence, learned facts, and blockers.
- `artifacts`: reviewable task outputs with kind, status, path, review history, approvals, and recommendations.
- `agents`: specialist execution slots.
- `events`: append-only run history.
- `specialistRoles`: role registry references backed by Souls role prompts.
- `autoRun`: local execution state only.
- `source`: project-relative source metadata where practical.

Readiness is derived: a task is ready when it is `todo`, has no owner, and all dependencies are `done`.

## Headless Access And App Boundary

`scripts/sprintengine_tool.py` is headless. It does not require desktop app login, Pro entitlements, daemon state, or renderer access. This is intentional so local automation and agents can inspect run state from a terminal.

The Multicode app may require a signed-in session to create, launch, or supervise specialist workflows through the UI. That login gate belongs to the app boundary. Sprint Engine core and CLI must not import app auth, upgrade, or entitlement modules.

## Swarm Compatibility

Swarm remains the compatibility consumer for Milestone 01. Continue using Swarm commands for task and artifact mutations:

```bash
scripts/swarm_tool.py task next --role developer --id developer-1
scripts/swarm_tool.py task log --task-id T8 --id developer-1 --summary "Updated docs" --file docs/sprintengine-cli.md --command "pytest ..." --result "Passed"
scripts/swarm_tool.py task status --task-id T8 --status done --id developer-1
```

Sprint Engine reads the same backing state and reports canonical execution objects without rewriting state files or changing timestamps.

## Output And Paths

CLI output is deterministic JSON with sorted keys. Source metadata and examples should use project-relative paths such as:

```text
swarm/01-shared-domain-cli-readonly/state.yaml
docs/sprintengine-cli.md
sprintengine_core/cli.py
souls/prompts/developer.md
```

Avoid absolute or machine-specific paths in docs, task evidence, artifacts, reports, and scripts.

## Packaging

The desktop package includes the Sprint Engine Python entry point, core Python modules, and `souls` resources needed by the role registry. Existing Swarm and Multiloop package resources remain intact.
