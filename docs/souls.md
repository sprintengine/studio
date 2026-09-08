# Souls

> **Being retired.** Owner ruling 2026-09-08 (`backlog/epics/roles-come-from-the-skill-pack.md`):
> the souls mechanism is retired in favour of role skills published as a skill
> pack, so this document describes a runtime on its way out rather than the
> shape roles will keep.

Souls are reusable role prompts for agent identity, judgment, and quality
standards. They are not Sprint Engine state, task cards, or workflow rules.

Current Souls are registry-backed. The active source of truth is the Sprint
Engine role registry, which discovers role manifests and skill documents from
workspace, plugin, user, and bundled search paths. Historical references to
`souls/prompts/<role>.md` describe the pre-registry migration source, not the
active runtime prompt loader.

Sprint Engine composes prompts in three layers:

1. Soul prompt rendered from a role manifest and its `soul` skill entries.
2. Sprint Engine coordination rules from `.agents/skills/sprintengine/prompts/<role>.md`.
3. Runtime directive from the Sprint Engine CLI, such as the current agent id, role, and next task command.

Standalone specialist terminals use the Soul prompt directly.

## CLI

Use the `souls` CLI to inspect the available registry roles and rendered
prompts:

```bash
scripts/souls list
scripts/souls get architect
scripts/souls get developer --format json
scripts/souls path security
scripts/souls validate
```

On Windows PowerShell:

```powershell
.\scripts\souls.cmd list
.\scripts\souls.cmd get architect
.\scripts\souls.cmd validate
```

The CLI reads local registry files. It does not download remote prompts.
Workspace-local role manifests under `.sprintengine/roles/`, plugin-scoped
registry folders, and user registry folders can all contribute roles — the
user layer is where the app installs the specialist pack shipped in
`resources/specialist-pack/`. There is no bundled `resources/sprintengine/roles/`
directory. Unknown roles fail clearly. They do not silently fall back to
another Soul.

The manifest key is `directives`, not `soul`. The v2 role manifest
(`sprintengine_core/role_registry.py`) composes the startup brief from
`directives.implement`, an ordered list of `{ "skill": "<id>" }` entries, with
one optional key per post-implementation phase (`review` is the only shipped
phase). A manifest still carrying `soul` or `capabilities` is rejected by name
with a `v1_role_manifest` warning; `summary` is ignored in favour of
`description`.

## Roles

The specialist pack in `resources/specialist-pack/roles/` ships:

- `architect`
- `blog_writer`
- `creative`
- `cross_platform`
- `developer`
- `devops`
- `frontend`
- `nuclear_reviewer`
- `performance`
- `presentation`
- `product`
- `production_readiness_reviewer`
- `security`
- `spec_reviewer`
- `tester`
- `ui_ux_reviewer`

Aliases are declared per manifest, in each role's own `aliases` array — there
is no central alias table. `scripts/souls list` prints each role with its
aliases.

Some bundled Souls exist for non-Sprint specialist surfaces. Sprint Engine
dispatchability is decided by the run roster, task roles, and quality gate
roles, not by this bundled list.

## Desktop App

When the desktop app spawns a standalone specialist agent, it resolves the selected specialist action to a canonical Soul role and injects a lightweight bootstrap prompt:

```text
Run `souls get <role>` now, treat the returned text as your role, judgment, and quality bar, then wait for the user's task or question.
```

The terminal bootstrap exposes a `souls` command where the app can resolve the packaged Souls resources. If the command is unavailable, the agent should stop and report that the Souls CLI is unavailable rather than guessing the role prompt.

When the desktop app starts a Sprint Engine agent, the terminal receives a
lightweight startup prompt telling it to run the Sprint Engine tool. The Sprint
Engine tool then composes the registry-backed Soul prompt with Sprint Engine
coordination rules and runtime task instructions.
