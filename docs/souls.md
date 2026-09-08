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
registry folders, user registry folders, and bundled
`resources/sprintengine/roles/` entries can all contribute roles. Unknown roles
fail clearly. They do not silently fall back to another Soul.

Role manifest `soul` entries are skill-only in the current schema:
`{ "skill": "<id>" }`. Inline text entries such as `{ "text": "..." }` are
not supported yet and fail validation as malformed Soul entries.

## Roles

Bundled roles:

- `architect`
- `coordinator`
- `product`
- `developer`
- `devops`
- `frontend`
- `blog_writer`
- `tester`
- `security`
- `code_reviewer`
- `spec_reviewer`
- `performance`
- `cross_platform`
- `presentation`

Supported aliases:

- `product-strategist` -> `product`
- `devops-infra` -> `devops`
- `frontend-design-review` -> `frontend`
- `blog-writer`, `content-writer`, `blogger` -> `blog_writer`
- `qa-test` -> `tester`
- `security-review` -> `security`
- `code-review`, `code-reviewer` -> `code_reviewer`
- `spec-review`, `spec-reviewer` -> `spec_reviewer`
- `performance-engineer` -> `performance`
- `cross-platform`, `compatibility`, `platform-compatibility` -> `cross_platform`
- `presenter`, `deck-writer`, `slide-author`, `slides` -> `presentation`

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
