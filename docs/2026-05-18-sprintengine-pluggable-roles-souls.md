# Sprint Engine: Pluggable Roles + Composable Souls

Date: 2026-05-18
Status: Design ready for implementation
Estimated scope: 4–6 focused phases, each independently shippable

## Mission

Make Sprint Engine's roles and the souls that drive them **pluggable**. Today the 13 bundled roles (architect, developer, frontend, tester, code_reviewer, etc.) are hardcoded in `souls/registry.py:SOULS`, `sprintengine_core/tool.py:VALID_ROLES`, the architect's prompt, and ~15 places in the renderer. A user who wants a `marketer` role has to fork the codebase.

After this work:

- Sprint Engine is **role-agnostic**. Tasks carry role strings; the registry decides what each role does.
- Roles are **composed from skills**, not authored as monolithic prompts. A "developer" soul is `["principal-engineer-identity", "core-principles", "risk-workflow", "no-mock-runtime", "post-change-self-review"]`. A user-defined "marketer" reuses the same shared skills plus its own identity and domain skills.
- The **local MCP server is the canonical interface**. Agents talk to it for everything — soul retrieval, task ops, gate verdicts, heartbeats. The CLI continues to exist for human use.
- **Server-side dispatch with subscriptions.** Sprint Engine picks which idle agent gets the next task (round-robin), pushes a dispatch notification, and updates state. Agents don't poll; they subscribe.
- **State-as-contract.** No output sentinels, no stdout heuristics. The agent's MCP calls into Sprint Engine *are* the completion signals. The runtime listens to state changes via MCP subscriptions and manages terminal lifecycle from those.

The work also positions Sprint Engine for **eventual extraction as a standalone package**. Today everything lives in this repo; nothing in the design assumes Multicode is the only consumer. A standalone Sprint Engine user runs `sprintengine mcp serve --workspace .` and connects their MCP-capable CLI (Claude Code, Codex, OpenCode, etc.) to it directly. Multicode just hosts the same MCP server with extra plugin-scope configuration on top.

## Architecture

### MCP-local server as canonical interface

The Sprint Engine MCP server is **the** interface for agents. Every agent operation — claim, comment, log evidence, publish, verdict, heartbeat — is an MCP tool call. The legacy CLI continues to work for humans and scripts but is no longer the agent's path.

This solves the cross-platform CLI/Python pain (PowerShell vs Bash quoting, Python venv discovery, npm-shim weirdness, exit-code propagation). Agents call MCP tools and get clean JSON responses, the same on Windows, macOS, Linux, WSL.

Local-only by default. Stdio transport. One process per Multicode app, multi-workspace inside it (each tool call carries `workspaceRoot`). Standalone Sprint Engine users invoke `sprintengine mcp serve --workspace <path>` for a single-workspace process.

### State-as-contract

The Sprint Engine run-files cluster is the durable contract:

- `run.yaml` — run spec: name, goal, status, roster, quality policy, agents map (with new fields below)
- `tasks/<status>/<seq>-<id>.json` — folder-store task records (source of truth for tasks)
- `artifacts/<status>/<id>.json` — folder-store artifact records
- `projection.json` — UI-derived view, written by the server
- `events.jsonl` — append-only event log
- `dispatch.jsonl` (new) — append-only dispatch ledger: `{ts, agentId, target: {taskOrGateId, kind, reason}}`
- `metrics/`, `runner/`, `reviews/`, `validation/` — existing supporting directories

`state.yaml` is gone. The folder-store layout already shipped on main; this design extends it with dispatch and liveness fields.

Every state mutation goes through the MCP server (or the CLI calling the same `sprintengine_core` library, which goes through the same file-locking). The UI reads `projection.json`; the runtime listens to MCP change notifications; standalone tools can poll the projection or subscribe over MCP. One contract, many consumers.

### Server-side dispatch with subscriptions

Agents are passive recipients of dispatch, not active claimers.

**Lifecycle:**

```
Agent spawns (Multicode runs the CLI; standalone user just runs the CLI)
Agent calls sprintengine.agent.join(role, agent_id, workspace_root)
  → server registers agent in run.yaml's agents map
  → server returns the composed soul (agent uses it as system prompt)
Agent calls sprintengine.subscribe(agent_id)
  → opens long-running MCP notification stream
  → agent is now idle, waiting for dispatch

[Time passes. Work lands. Server's scheduler picks this agent for a task or gate.]

Server emits notification: sprintengine.dispatch { agentId, target: { taskId | gateId, role, reason } }
  → server has already mutated state.yaml-equivalent in folder-store to record the assignment
Agent receives notification
Agent does its work, calling MCP tools to read task details, write comments, log evidence
Agent calls sprintengine.task.publish or sprintengine.gate.publish when done
  → server records the verdict, advances state per progression rules, dispatches next agent
Agent returns to idle, subscription stays open

[On graceful shutdown:]
Agent calls sprintengine.agent.leave(agent_id)
  → server releases any claims, removes from agents map
```

**Scheduling policy**: round-robin among idle agents of the requested role. (Future v2 refinements: affinity-aware re-dispatch for rework loops, user-pinned filters, manual UI dispatch.)

**Liveness**: strict heartbeat. Each agent calls `sprintengine.agent.heartbeat(agent_id)` every 30 seconds. The server marks an agent dead if no heartbeat for 90 seconds; claims are released, work is re-dispatched, agent removed from the available pool. (Future v2 refinement: hybrid liveness — Multicode signals death immediately via `agent.leave` on pty exit, with heartbeat as a backstop.)

### Server-driven progression

The server does everything that's a deterministic function of state. The orchestrator does everything that requires understanding what the work *means*.

**Server handles automatically:**

- All required gates approved on a task → task transitions to `done`.
- A gate verdict of `changes_requested` → task transitions back to `changes_requested` status, rework gate(s) reset, server dispatches the implementer (or assigned role) for rework.
- Task dependencies satisfied → task becomes `ready` and joins the dispatchable queue.
- Agent dies (no heartbeat) → server releases the agent's claims, re-dispatches the work.
- Implementation tasks all `done` + run policy includes final reviews → server dispatches the orchestrator with a "schedule final reviews" task.
- Final review evidence available → server dispatches the orchestrator with a "sign off or schedule further work" task.

**Orchestrator handles (server dispatches it when judgment is needed):**

- Initial plan generation (build the task graph, set dependencies, attach gates).
- Deciding which gates apply per task. The `appliesWhen` schema was deliberately not built — the orchestrator decides at plan time based on paths, scope, and risk.
- Setting acceptance criteria and notes on each task.
- Reviewing a `changes_requested` verdict and deciding if the rework is straightforward (rework gate handles it) or if new follow-up tasks are needed.
- Final signoff.

**Key shift**: the orchestrator becomes a continuously-present worker. It joins via `agent.join` like every other role, subscribes, sits idle. The server dispatches it when a judgment is needed. The orchestrator's prompt drops the "remember to schedule final reviews after impl completes" prose — it just answers whatever dispatch arrives.

## Schema

### Role manifest

```jsonc
{
  "id": "developer",
  "label": "Developer",
  "aliases": [],
  "summary": "Builds core logic, integrations, and refactors.",
  "icon": "code",

  "implementer": {
    "enabled": true
  },

  "gate": {
    "enabled": false
  },

  "scheduling": {
    "canReviewPlans": false,
    "canBeOrchestrator": false
  },

  "soul": [
    { "skill": "principal-engineer-identity" },
    { "skill": "core-engineering-principles" },
    { "skill": "risk-workflow" },
    { "skill": "code-quality-bar" },
    { "skill": "no-mock-runtime" },
    { "skill": "avoid-ai-slop" },
    { "skill": "post-change-self-review" },
    { "skill": "collaboration-norms" }
  ],

  "multiloop": {
    "enabled": false
  }
}
```

**Reviewer example:**

```jsonc
{
  "id": "code_reviewer",
  "label": "Code Reviewer",
  "summary": "Reviews implementation quality before validation.",
  "icon": "review",

  "implementer": { "enabled": false },

  "gate": {
    "enabled": true,
    "phase": "review",
    "focus": "correctness, integration risk, maintainability, regressions, and evidence quality",
    "artifactKind": "code_review",
    "allowSelfReview": false
  },

  "scheduling": {
    "canReviewPlans": true,
    "canBeOrchestrator": false
  },

  "soul": [
    { "skill": "senior-reviewer-identity" },
    { "skill": "code-review-rubric" },
    { "skill": "ai-slop-detection" },
    { "skill": "evidence-quality-assessment" },
    { "skill": "post-change-self-review" }
  ]
}
```

**Orchestrator example:**

```jsonc
{
  "id": "orchestrator",
  "label": "Orchestrator",
  "aliases": ["architect"],
  "summary": "Plans the work, owns dependencies, schedules final reviews, signs off.",
  "icon": "architecture",

  "implementer": { "enabled": true },

  "gate": {
    "enabled": true,
    "phase": "review",
    "focus": "architecture, state model, projection, CLI, and cross-cutting coordination risk",
    "artifactKind": "architect_review",
    "allowSelfReview": true
  },

  "scheduling": {
    "canReviewPlans": false,
    "canBeOrchestrator": true
  },

  "soul": [
    { "skill": "orchestrator-identity" },
    { "skill": "task-graph-design" },
    { "skill": "quality-gate-selection" },
    { "skill": "final-review-scheduling" },
    { "skill": "dispatch-response-protocol" },
    { "skill": "risk-workflow" },
    { "skill": "post-change-self-review" }
  ]
}
```

**Canonical id**: `orchestrator`. Aliases: `architect` resolves to it for back-compat with existing prompts and docs (no live runs to migrate, but the prose throughout the codebase mentions "architect" — aliases save us from a sweeping rename right now). New state files use `orchestrator`.

### Skill format

A skill is a folder. Folder name = skill id.

```
resources/sprintengine/skills/risk-workflow/SKILL.md
```

```markdown
---
name: risk-workflow
description: How to classify the risk of an engineering task before acting.
consumers: [soul]
---

# Risk Workflow

Classify the work before acting:

- **Low risk**: isolated fixes, tests, validation, logging, internal refactors...
- **Medium risk**: new internal endpoints, modified business rules...
- **High risk**: auth, permissions, sessions, secrets, payments...
```

When composing into a soul, frontmatter is stripped; only the body becomes part of the system prompt. Frontmatter exists for tooling discovery, documentation, and (optionally) for the existing Anthropic-runtime skill loader, which can ignore soul-only skills via the `consumers` field.

**Variable substitution**: a tight allow-list of `{{role}}`, `{{role_label}}`, `{{workspace_root}}`, `{{run_id}}`. Mustache-style. No expressions, no conditionals.

### Soul composition

`soul` is an ordered list of entries:

```jsonc
"soul": [
  { "skill": "principal-engineer-identity" },
  { "skill": "core-engineering-principles" },
  { "skill": "risk-workflow" }
]
```

Entry shape is a discriminated union:

- `{ "skill": "<id>" }` — resolve `id` against the search path, read `SKILL.md`, strip frontmatter, append body
- `{ "text": "<inline string>" }` — accepted by the validator (forward-compatible schema), implementation deferred to a follow-up

The renderer concatenates resolved entries with `\n\n` between them. The result is the system prompt the agent receives via `sprintengine.soul.get(role)`.

### Search path

Highest precedence wins. Each layer scans for `roles/<id>.json` and `skills/<id>/SKILL.md`.

| Layer | Path | Configured by |
|---|---|---|
| Workspace-local | `<workspace>/.sprintengine/{roles,skills}/` | Workspace owner; project-specific overrides |
| Plugin-scoped | varies by plugin | Multicode passes `--extra-dir <plugin>/sprintengine` when launching the server |
| User | `~/.sprintengine/{roles,skills}/` | User; personal overrides across all workspaces |
| Bundled | `resources/sprintengine/{roles,skills}/` (in Multicode) or the equivalent in standalone Sprint Engine | Ships with Sprint Engine |

**Conflict resolution**: first match wins by precedence. The server logs an info-level "shadowing" message when a higher-precedence skill or role overrides a lower one (single log line on load, not per-call).

## File locations

```
resources/sprintengine/                # bundled (ships with Sprint Engine)
  roles/
    orchestrator.json
    product.json
    developer.json
    frontend.json
    tester.json
    security.json
    code_reviewer.json
    spec_reviewer.json
    performance.json
    # ... migrated from current souls/
  skills/
    principal-engineer-identity/
      SKILL.md
    risk-workflow/
      SKILL.md
    avoid-ai-slop/
      SKILL.md
    no-mock-runtime/
      SKILL.md
    post-change-self-review/
      SKILL.md
    # ... extracted from current souls/prompts/

~/.sprintengine/                       # user-installed (cross-workspace)
  roles/
    marketer.json
  skills/
    brand-voice/
      SKILL.md

<workspace>/.sprintengine/             # workspace-local (project-specific overrides)
  roles/
  skills/

<cli-plugin-root>/sprintengine/        # plugin-scoped (loaded when that plugin is active)
  roles/
  skills/
```

Sprint Engine bundled content sits as a single directory at `resources/sprintengine/`, next to `resources/plugins/` (BYO-CLI), `resources/skills/` (Anthropic-runtime), and `resources/skill-packs/`. Each extension surface gets its own directory. When Sprint Engine extracts to a standalone package, `resources/sprintengine/` moves with it as a unit.

## MCP API surface (v1)

The full surface for agents and renderer is in v1. The CLI continues to exist as a thin wrapper around the same `sprintengine_core` library for humans.

### Agent lifecycle

- `sprintengine.agent.join(role, agentId, workspaceRoot) → { soul: <composed-prompt-string>, role: <manifest>, runMeta: {...} }`
- `sprintengine.agent.heartbeat(agentId)`
- `sprintengine.agent.leave(agentId, reason?)`
- `sprintengine.subscribe(agentId)` — opens the dispatch notification stream

### Server → agent notifications

- `sprintengine.dispatch { agentId, target: { taskId | gateId, role, reason } }` — server has assigned this agent
- `sprintengine.run.status_changed { workspaceRoot, status }` — informational
- `sprintengine.cancel { agentId, reason }` — server is revoking the agent's current claim

### Discovery

- `sprintengine.roles.list(workspaceRoot) → [<role-manifest>, ...]`
- `sprintengine.roles.get(workspaceRoot, roleId) → <role-manifest>`
- `sprintengine.soul.get(workspaceRoot, roleId) → <composed-prompt-string>`
- `sprintengine.skills.list(workspaceRoot) → [<skill-summary>, ...]`
- `sprintengine.skill.get(workspaceRoot, skillId) → { frontmatter, body }`

### Task ops

- `sprintengine.task.get(workspaceRoot, taskId) → <task>`
- `sprintengine.task.list(workspaceRoot, filter?) → [<task>, ...]`
- `sprintengine.task.comment(workspaceRoot, taskId, body, commentType, paths?, data?)`
- `sprintengine.task.log(workspaceRoot, taskId, id, summary, files?, commands?, results?, scopeExpansionJson?)`
- `sprintengine.task.publish(workspaceRoot, taskId, summary, commands?, touchedFiles?, comment?)`
- `sprintengine.task.request_changes(workspaceRoot, taskId, reason)`
- `sprintengine.task.status(workspaceRoot, taskId, status, feedbackFields?)`

### Gate ops

- `sprintengine.gate.publish(workspaceRoot, gateId, verdict, summary, evidence?, feedbackFields?)`
- `sprintengine.gate.skip(workspaceRoot, gateId, rationale)`
- `sprintengine.gate.list(workspaceRoot, taskId) → [<gate>, ...]`

### Artifact ops

- `sprintengine.artifact.add(workspaceRoot, taskId, kind, path, summary?)`
- `sprintengine.artifact.ready(workspaceRoot, artifactId)`
- `sprintengine.artifact.approve(workspaceRoot, artifactId, verdict, comment?)`
- `sprintengine.artifact.list(workspaceRoot, filter?) → [<artifact>, ...]`

### Orchestrator ops

- `sprintengine.plan.add_task(workspaceRoot, title, role, description, acceptance, paths?, dependsOn?, notes?, gates?)`
- `sprintengine.plan.update_task(workspaceRoot, taskId, fields)`
- `sprintengine.plan.delete_task(workspaceRoot, taskId, unlinkDependents?)`
- `sprintengine.plan.add_dependency(workspaceRoot, taskId, dependsOn)`
- `sprintengine.plan.remove_dependency(workspaceRoot, taskId, dependsOn)`
- `sprintengine.plan.list(workspaceRoot) → [<task>, ...]`
- `sprintengine.plan.review_status(workspaceRoot) → <summary>`
- `sprintengine.plan.address_reviews(workspaceRoot, actor)`

### Run ops

- `sprintengine.run.get(workspaceRoot) → <run.yaml content>`
- `sprintengine.run.policy.get(workspaceRoot) → <quality policy>`
- `sprintengine.run.projection(workspaceRoot) → <projection.json content>`
- `sprintengine.run.subscribe(workspaceRoot)` — UI subscription for state changes

## Migration of the 13 bundled souls

The 13 monolithic prompts in `souls/prompts/` get migrated to manifest + composed skills on day one. The work splits into editorial extraction and per-role assembly.

### Shared skills to extract

After reading all 13 prompts, the obvious cross-cutting sections that repeat (with minor wording variance) are:

- `risk-workflow` — the low/medium/high classification (in developer, architect, devops, security, performance)
- `avoid-ai-slop` — the anti-pattern list (in developer, architect, frontend, devops)
- `no-mock-runtime` — the "do not claim work is complete when behavior depends on mocks" contract (in developer, frontend, devops)
- `post-change-self-review` — the review-your-own-work gate (in nearly every soul)
- `code-quality-bar` — the input validation, transaction scoping, retry/timeout/idempotency, no-secrets-in-logs list (in developer, frontend)
- `collaboration-norms` — ask-when-wrong-assumption-creates-risk; make-reasonable-assumptions-and-disclose (in nearly every soul)
- `evidence-quality-assessment` — what good evidence looks like (in code_reviewer, spec_reviewer, tester)
- `dispatch-response-protocol` — how to handle a server-dispatched task vs orchestrator-self-initiated work (new, written for the orchestrator)

### Per-role identity skills

Each role gets its own identity skill capturing the role-specific persona:

- `orchestrator-identity`, `principal-engineer-identity`, `senior-reviewer-identity`, `senior-tester-identity`, `senior-product-strategist-identity`, `frontend-engineer-identity`, `devops-engineer-identity`, `security-specialist-identity`, `performance-engineer-identity`, `blog-writer-identity`, `presentation-author-identity`, `coordinator-identity`, `spec-reviewer-identity`

### Role-specific skills

Where a section is unique to one role and not shared, it becomes a role-specific skill. Examples:

- `task-graph-design` (orchestrator only)
- `quality-gate-selection` (orchestrator only)
- `final-review-scheduling` (orchestrator only)
- `code-review-rubric` (code_reviewer only)
- `spec-coverage-rubric` (spec_reviewer only)
- `validation-evidence-standards` (tester only)
- `accessibility-bar` (frontend only)
- `performance-measurement` (performance only)
- `security-review-rubric` (security only)
- `devops-runbook-standards` (devops only)

### Editorial pass

For each of the 13 current prompts, the work is:

1. Identify shared sections, replace inline content with a `{ "skill": "<shared-skill-id>" }` reference.
2. Extract role-specific sections into per-role identity and role-specific skill files.
3. Author the manifest with `id`, `label`, `summary`, `icon`, `implementer.enabled`, `gate.*` (if applicable), `scheduling.*`, and the soul array.
4. Sanity-check the composed output: render the soul through the new path and diff against today's monolithic prompt. Where there's drift, decide whether to update the new version (because today's prose was outdated) or restore the prose (because the new composition lost meaning).

## Implementation phases

Each phase is independently shippable and leaves the system in a working state.

### Phase A — Schema, search path, and soul-skill composition mechanic

- Define the role-manifest schema (TypeScript types + JSON Schema + Python dataclasses).
- Define the skill folder format and frontmatter conventions.
- Build the soul renderer: takes a manifest + workspace path + search-path config → composed prompt string. Pure function in `sprintengine_core`, fully unit-tested.
- Build the registry loader: scans the search-path layers, validates manifests and skill folders, surfaces broken entries as warnings (skipped, not fatal).
- New `sprintengine` CLI commands for humans: `sprintengine roles list`, `sprintengine role get`, `sprintengine soul get`, `sprintengine skill list`, `sprintengine skill get`. These exercise the registry through the same library agents will use via MCP.
- **Does not touch existing souls or the architect prompt yet.** New mechanic available, old mechanic still runs.

### Phase B — Extract shared skills, migrate the 13 bundled roles

- Author the shared skill files (`risk-workflow`, `avoid-ai-slop`, `no-mock-runtime`, etc.) in `resources/sprintengine/skills/`.
- Author the per-role identity skills and role-specific skills.
- Author the 13 role manifests in `resources/sprintengine/roles/`.
- Diff each composed output against today's prompt; resolve drift.
- Delete `souls/prompts/<role>.md` and the `souls/registry.py:SOULS` hardcoded tuple. The Python `souls` CLI continues to work but is a thin wrapper around the new registry.

### Phase C — MCP server scaffolding and agent lifecycle

- Sprint Engine MCP server gains the agent-lifecycle tools (`agent.join`, `agent.heartbeat`, `agent.leave`, `subscribe`) and the discovery tools (`roles.list`, `role.get`, `soul.get`, `skill.*`).
- Server tracks agents in `run.yaml`'s agents map with new `heartbeatAt`, `subscribedAt`, `status` fields.
- Notification machinery (server → subscribed agents): the server can push `sprintengine.dispatch`, `sprintengine.cancel`, `sprintengine.run.status_changed` events.
- A reconciliation tick (every N seconds) detects agents past the 90s heartbeat threshold, releases their claims, marks them dead.
- **No agent code uses this yet.** Server-side wiring lands; no consumer integration.

### Phase D — Server-side dispatch + state-driven progression

- Scheduler implementation: round-robin among idle agents of the requested role.
- Dispatch ledger (`dispatch.jsonl`) appended on every assignment.
- Server-driven state transitions:
  - All gates approved → task `done`.
  - Gate `changes_requested` → task `changes_requested`, rework gate reset, re-dispatch implementer.
  - Implementation tasks `done` + run policy requires final reviews → dispatch orchestrator with "schedule final reviews."
  - Final review evidence available → dispatch orchestrator with "sign off or schedule more work."
- Architect prompt rewritten: agent uses MCP, responds to dispatches, no longer remembers lifecycle rules. New `dispatch-response-protocol` skill in the orchestrator's soul.

### Phase E — Task/gate/artifact ops via MCP, runtime integration

- Full MCP tool surface (task ops, gate ops, artifact ops, orchestrator ops) — all behavior the CLI does, exposed as MCP tools.
- Multicode runtime: replaces the existing terminal-spawn-and-pty-watch flow with subscribe-to-MCP-events. Spawns worker terminals on demand based on scheduler events. Reads `projection.json` and MCP notifications for UI updates.
- Renderer: subscribes to MCP `run.subscribe` for reactive state. Drops `Record<SprintEngineRole, X>` patterns in favour of registry-driven maps.
- Removal of the legacy `--print` / output-sentinel / state.yaml code paths (already gone on main, but verify nothing crept back).

### Phase F — Settings UI for roles + plugin-scoped skills + standalone polish

- Settings UI "Roles" tab: lists installed roles, enable/disable per-workspace, install-from-URL or install-from-folder.
- Plugin manifest's existing `souls.directory` hook wired so a CLI plugin can ship `<plugin-root>/sprintengine/{roles,skills}/`.
- Standalone Sprint Engine packaging polish: the `sprintengine mcp serve` command works without Multicode, ships with the same bundled content, accepts `--user-dir`, `--workspace`, `--extra-dir` flags.

## Settings UI scope (v1)

The "Roles" tab in Settings:

- Lists installed roles (bundled + user + plugin-scoped) with their `label`, `summary`, `icon`, source layer, and enable/disable toggle.
- "Install role from URL" — fetches a `role.json` plus its referenced skill folders, validates, writes to `~/.sprintengine/`.
- "Install role from folder" — file picker for local install.
- Per-role variable form (rendered from the manifest's optional `variables:` block, if we add one). Not in v1; manifests don't declare variables yet.

No authoring UI in v1. Users compose roles by editing JSON manifests. A "compose a role from skills" wizard is a clear v2 feature.

## Run-files cluster additions

Extends what already exists; no rewrite.

**`run.yaml` agents map** gains:

```yaml
agents:
  frontend-2:
    role: frontend
    status: idle              # idle | busy | dead
    currentTaskId: null
    heartbeatAt: 2026-05-18T10:23:14Z
    subscribedAt: 2026-05-18T10:00:00Z
    joinedAt: 2026-05-18T10:00:00Z
```

**New file `dispatch.jsonl`** (append-only, sibling of `events.jsonl`):

```jsonl
{"ts":"2026-05-18T10:01:23Z","agentId":"frontend-2","target":{"kind":"gate","id":"G3","role":"frontend","reason":"new"}}
{"ts":"2026-05-18T10:02:45Z","agentId":"developer-1","target":{"kind":"task","id":"T5","role":"developer","reason":"changes_requested rework"}}
```

Useful for replay, debugging round-robin, and analytics later.

## Multiloop

Parked for this work. Multiloop is its own workspace mode, not finished, and overlaps conceptually but doesn't share lifecycle code with Sprint Engine. A dedicated fix-up task should follow this work to either bring multiloop into the same registry + dispatch model or sunset it cleanly. Adding a `future-plans/2026-05-18-multiloop-fix-up.md` placeholder so it doesn't get lost.

## Open questions

A few small decisions to revisit during implementation, called out so they're not forgotten:

- **MCP transport details.** Stdio for the local server is the convention. If a future remote-MCP catalog feature lands (for role/skill content distribution), it would use SSE or HTTP-streaming; out of scope for this work.
- **Recovery from server crash.** Currently the server holds dispatch state in memory plus what's in the folder store. On restart, it reads the run files and re-computes the agent registry from `agents` map. Unclaimed in-flight dispatches are re-emitted to subscribed agents. Detailed sequence to nail down during Phase C.
- **Subscription persistence across reconnect.** When an agent's MCP client reconnects (after a transient drop), it should re-issue `subscribe` and the server should resume sending notifications. Standard MCP pattern; verify the protocol supports it the way we need.
- **Editorial drift detection.** When migrating each of the 13 souls, the diff between the old monolithic prompt and the new composed output may reveal outdated prose that needs to be either updated or restored. Track each diff decision in a `MIGRATION-NOTES.md` per role for posterity.
- **AgentCli generalisation** (BYO-CLI Phase 2e — `AgentCli = 'codex' | 'claude'` → `string`). Still pending; doesn't block this work; can be done in parallel.

## Non-goals

- **Multiloop refactor.** Parked, separate task.
- **Authoring UI** (drag-and-drop role/soul composer). Defer to v2.
- **Remote MCP catalog** for role/skill distribution. Interesting future direction; not in this scope.
- **Sprint Engine physical extraction** into a standalone package. The design supports it; doing the actual git/PyPI extraction is a separate operational task.
- **Performance benchmarking** of MCP round-trips vs CLI shell-out. Assumed fine; revisit if profiling shows otherwise.
- **Codex Windows path migration** (BYO-CLI follow-up — `-C cwd`, npm-shim, prompt escaping). Independent.

## Success criteria

When this work ships:

1. A user can drop `~/.sprintengine/roles/marketer.json` referencing `~/.sprintengine/skills/brand-voice/SKILL.md` and a few shared skills, and the orchestrator can assign marketing tasks to that role just like assigning to `developer`.
2. The Settings UI "Roles" tab shows the new role alongside bundled ones.
3. An agent spawned for the marketer role calls `sprintengine.agent.join`, gets its composed soul as a system prompt via MCP, sits idle until the server dispatches, does the work, publishes via `sprintengine.task.publish`, returns to idle.
4. The orchestrator agent stays alive across the whole run, gets dispatched by the server for planning, review-follow-up decisions, final-review scheduling, and signoff.
5. The runtime no longer watches pty output for completion signals. It listens to MCP `run.subscribe` events for state changes and manages terminal lifecycle from those.
6. No `state.yaml` files written. No `[sprint-engine:done]` sentinels. No shell-quoted `souls get developer` invocations from agents.
7. The CLI continues to work for humans (`sprintengine task add`, etc.) — same surface, now a thin client of the same `sprintengine_core` library the MCP server uses.

If all seven are true, the work is done.
