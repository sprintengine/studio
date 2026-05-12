# Souls

Souls are reusable role prompts for agent identity, judgment, and quality standards. They are not Sprint Engine state, task cards, or workflow rules.

Sprint Engine composes prompts in three layers:

1. Soul prompt from `souls/prompts/<role>.md`.
2. Sprint Engine coordination rules from `.agents/skills/sprintengine/prompts/<role>.md`.
3. Runtime directive from the Sprint Engine CLI, such as the current agent id, role, and next task command.

Standalone specialist terminals use the Soul prompt directly.

## CLI

Use the `souls` CLI to inspect the available role prompts:

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

The CLI reads local packaged files. It does not download remote prompts.

## Roles

Canonical roles:

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

Supported aliases:

- `multiloop-coordinator` -> `coordinator`
- `product-strategist` -> `product`
- `devops-infra` -> `devops`
- `frontend-design-review` -> `frontend`
- `blog-writer`, `content-writer`, `blogger` -> `blog_writer`
- `qa-test` -> `tester`
- `security-review` -> `security`
- `code-review`, `code-reviewer` -> `code_reviewer`
- `spec-review`, `spec-reviewer` -> `spec_reviewer`
- `performance-engineer` -> `performance`

Unknown roles fail clearly. They do not silently fall back to another Soul.

## Desktop App

When the desktop app spawns a standalone specialist agent, it resolves the selected specialist action to a canonical Soul role and injects a lightweight bootstrap prompt:

```text
Run `souls get <role>` now and treat the returned text as your role, judgment, and quality bar.
```

The terminal bootstrap exposes a `souls` command where the app can resolve the packaged Souls resources. If the command is unavailable, the agent should stop and report that the Souls CLI is unavailable rather than guessing the role prompt.

When the desktop app starts a Sprint Engine agent, the terminal receives a lightweight startup prompt telling it to run the Sprint Engine tool. The Sprint Engine tool then composes the Soul prompt with Sprint Engine coordination rules and runtime task instructions.
