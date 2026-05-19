# Bundled Soul Migration Notes

This migration moves the 13 existing bundled Souls from `souls/prompts/*.md` into registry-backed role manifests and skill documents under `resources/sprintengine`.

Each migrated role is marked as `direct extraction`: the skill body is the current legacy prompt content copied without prose changes. This intentionally preserves current behavior for the first source-of-truth migration. Shared prose was not factored in this task because the repeated themes are embedded in role-specific rubrics with materially different wording; extracting them now would create avoidable drift before the CLI and app are switched to registry rendering.

| Role | Manifest | Skill | Drift decision |
| --- | --- | --- | --- |
| `coordinator` | `resources/sprintengine/roles/coordinator.json` | `resources/sprintengine/skills/coordinator/SKILL.md` | Direct extraction from `souls/prompts/coordinator.md`; no intentional prose drift. |
| `architect` | `resources/sprintengine/roles/architect.json` | `resources/sprintengine/skills/architect/SKILL.md` | Direct extraction from `souls/prompts/architect.md`; no intentional prose drift. |
| `product` | `resources/sprintengine/roles/product.json` | `resources/sprintengine/skills/product/SKILL.md` | Direct extraction from `souls/prompts/product.md`; no intentional prose drift. |
| `developer` | `resources/sprintengine/roles/developer.json` | `resources/sprintengine/skills/developer/SKILL.md` | Direct extraction from `souls/prompts/developer.md`; no intentional prose drift. |
| `devops` | `resources/sprintengine/roles/devops.json` | `resources/sprintengine/skills/devops/SKILL.md` | Direct extraction from `souls/prompts/devops.md`; no intentional prose drift. |
| `frontend` | `resources/sprintengine/roles/frontend.json` | `resources/sprintengine/skills/frontend/SKILL.md` | Direct extraction from `souls/prompts/frontend.md`; no intentional prose drift. |
| `blog_writer` | `resources/sprintengine/roles/blog_writer.json` | `resources/sprintengine/skills/blog_writer/SKILL.md` | Direct extraction from `souls/prompts/blog_writer.md`; no intentional prose drift. |
| `tester` | `resources/sprintengine/roles/tester.json` | `resources/sprintengine/skills/tester/SKILL.md` | Direct extraction from `souls/prompts/tester.md`; no intentional prose drift. |
| `security` | `resources/sprintengine/roles/security.json` | `resources/sprintengine/skills/security/SKILL.md` | Direct extraction from `souls/prompts/security.md`; no intentional prose drift. |
| `code_reviewer` | `resources/sprintengine/roles/code_reviewer.json` | `resources/sprintengine/skills/code_reviewer/SKILL.md` | Direct extraction from `souls/prompts/code_reviewer.md`; no intentional prose drift. |
| `spec_reviewer` | `resources/sprintengine/roles/spec_reviewer.json` | `resources/sprintengine/skills/spec_reviewer/SKILL.md` | Direct extraction from `souls/prompts/spec_reviewer.md`; no intentional prose drift. |
| `performance` | `resources/sprintengine/roles/performance.json` | `resources/sprintengine/skills/performance/SKILL.md` | Direct extraction from `souls/prompts/performance.md`; no intentional prose drift. |
| `presentation` | `resources/sprintengine/roles/presentation.json` | `resources/sprintengine/skills/presentation/SKILL.md` | Direct extraction from `souls/prompts/presentation.md`; no intentional prose drift. |

Alias preservation:
- `coordinator`: `multiloop-coordinator`
- `architect`: None
- `product`: `product-strategist`
- `developer`: None
- `devops`: `devops-infra`
- `frontend`: `frontend-design-review`
- `blog_writer`: `blog-writer`, `content-writer`, `blogger`
- `tester`: `qa-test`
- `security`: `security-review`
- `code_reviewer`: `code-review`, `code-reviewer`
- `spec_reviewer`: `spec-review`, `spec-reviewer`
- `performance`: `performance-engineer`
- `presentation`: `presenter`, `deck-writer`, `slide-author`, `slides`

Non-dispatch Soul note:

`coordinator`, `devops`, `blog_writer`, and `presentation` are migrated so they remain renderable through the Souls registry, but this task does not add them to Sprint Engine dispatch roles.
