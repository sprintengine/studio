# Sprint Engine: Pluggable Roles + Composable Souls

Date: 2026-05-18
Status: Design requires runtime revision after MCP wake-up feasibility
Estimated scope: One integrated implementation with an early feasibility checkpoint.

## Mission

Make Sprint Engine's roles and the souls that drive them **pluggable**. Today the 13 bundled roles (architect, developer, frontend, tester, code_reviewer, etc.) are hardcoded in `souls/registry.py:SOULS`, `sprintengine_core/tool.py:VALID_ROLES`, the architect's prompt, and ~15 places in the renderer. A user who wants a `marketer` role has to fork the codebase.

After this work:

- Sprint Engine is **role-agnostic**. Tasks carry role strings; the registry decides what each role does.
- Roles are **composed from skills**, not authored as monolithic prompts. A "developer" soul is `["principal-engineer-identity", "core-principles", "risk-workflow", "no-mock-runtime", "post-change-self-review"]`. A user-defined "marketer" reuses the same shared skills plus its own identity and domain skills.
- The **local MCP server becomes the preferred machine interface**. Agents should eventually talk to it for soul retrieval, task ops, gate verdicts, heartbeats, and dispatch. The CLI continues to exist for human use and compatibility.
- **Server-side dispatch with Multicode-managed wake-up.** Sprint Engine can still choose work and record dispatch state, but the 2026-05-19 feasibility pass did not prove that target CLIs wake or resume from server-originated MCP notifications. Multicode must remain responsible for spawning, focusing, or injecting terminal input to resume agents until a separate compatibility effort proves direct MCP wake-up.
- **State-as-contract.** No output sentinels, no stdout heuristics. The agent's Sprint Engine calls are the completion signals. The runtime may listen to state changes via projection updates or compatible MCP subscriptions, but Multicode remains responsible for terminal lifecycle and wake/resume behavior.

The work also positions Sprint Engine for **eventual extraction as a standalone package**. Today everything lives in this repo; nothing in the design assumes Multicode is the only consumer. A standalone Sprint Engine user runs `sprintengine mcp serve --workspace .` or `python -m sprintengine_mcp --workspace .` and connects their MCP-capable CLI (Claude Code, Codex, OpenCode, etc.) to it directly if those CLIs can support the required notification/resume behavior. Multicode hosts the same MCP server with extra plugin-scope configuration on top.

## Implementation Approach

This is one product change, not a compatibility roadmap. The end goal is the MCP-dispatched, pluggable-role Sprint Engine described here.

The early checkpoint is complete enough to reject direct MCP wake-up as a production assumption for current planning. The isolated harness can emit delayed server-originated notifications, but Codex 0.130.0 and Claude Code 2.1.144 did not establish a connected idle MCP session with the harness. The runtime design must therefore keep Multicode terminal/session orchestration responsible for waking or resuming agents. MCP remains useful as a state and operation boundary after a CLI connection is established, but WP6/WP7 must not depend on direct server notifications waking idle model sessions.

## Compatibility Stance

There are no external users or long-lived Sprint Engine runs that this design must preserve compatibility with. Existing repo-local runs, prompts, and docs are implementation context, not compatibility contracts.

Implications:

- We can change persisted Sprint Engine schemas, command names, role registry structure, renderer types, and prompt composition when that makes the new design cleaner.
- We do not need migration code for old run stores unless it is useful for local dogfooding or tests.
- We should still keep the implementation coherent at every committed phase: no half-migrated role ids, no mixed old/new prompt loaders on the active path, and no UI paths that silently parse obsolete state.
- Current files are useful for source-of-truth behavior and regression tests, but not blockers if the new contract is clearer.

After the checkpoint, implement the work as one coherent replacement:

- Replace hardcoded role/soul registries with a search-path-backed role and skill registry.
- Keep the Sprint Engine coordination prompt layer owned by Sprint Engine.
- Move agent lifecycle, heartbeat, dispatch, and task/gate ops toward the MCP/state contract where real clients support it, while keeping terminal lifecycle and wake/resume behavior under Multicode control.
- Let users override bundled roles or add new roles by dropping schema-valid files into configured local folders.
- Keep the roster extensible: task role strings come from configured roles, not a hardcoded enum.

## Architecture

### MCP-local server as preferred machine interface

The Sprint Engine MCP server is the preferred machine boundary for agents. Agent operations such as claim, comment, log evidence, publish, verdict, heartbeat, dispatch observation, and registry discovery are exposed as structured MCP tool calls. The CLI remains the current compatibility and startup path for humans, scripts, and Multicode-launched agents while the runtime still depends on terminal/session orchestration.

This solves the cross-platform CLI/Python pain (PowerShell vs Bash quoting, Python venv discovery, npm-shim weirdness, exit-code propagation). Agents call MCP tools and get clean JSON responses, the same on Windows, macOS, Linux, WSL.

Local-only by default. Stdio transport. One process per Multicode app, multi-workspace inside it (each tool call carries `workspaceRoot`). Standalone Sprint Engine users invoke `sprintengine mcp serve --workspace <path>` or `python -m sprintengine_mcp --workspace <path>` for a single-workspace process. The `sprintengine mcp serve` command delegates to the module entrypoint and accepts repeated `--extra-dir <registry-root>` flags for plugin role/skill roots plus `--user-dir <path>` for a custom user registry base.

### State-as-contract

The Sprint Engine run-files cluster is the durable contract:

- `run.yaml` — run spec: name, goal, status, roster, quality policy, agents map (with new fields below)
- `tasks/<status>/<seq>-<id>.json` — folder-store task records (source of truth for tasks)
- `artifacts/<status>/<id>.json` — folder-store artifact records
- `projection.json` — UI-derived view, written by the server
- `events.jsonl` — append-only event log
- `dispatch.jsonl` — append-only dispatch ledger: `{id, timestamp, agentId, role, target, reason, state, outcome, source}`
- `metrics/`, `runner/`, `reviews/`, `validation/` — existing supporting directories

`state.yaml` is gone. The folder-store layout already shipped on main; this design extends it with dispatch and liveness fields.

Every state mutation goes through the MCP server (or the CLI calling the same `sprintengine_core` library, which goes through the same file-locking). The UI reads `projection.json`; the runtime listens to MCP change notifications; standalone tools can poll the projection or subscribe over MCP. One contract, many consumers.

### Server-side dispatch with Multicode wake-up

Agents should no longer be planned as purely passive recipients of MCP dispatch notifications. The MCP wake-up/resume feasibility checkpoint did not prove that Codex or Claude Code can be resumed by server-originated notifications, so the production runtime must use Multicode's terminal/session supervisor to wake, focus, or inject the next directive when work is assigned.

**Lifecycle:**

```
Agent spawns (Multicode runs the CLI; standalone user just runs the CLI)
Agent calls sprintengine.agent.join(role, agent_id, workspace_root)
  → server registers agent in run.yaml's agents map
  → server returns the composed soul (agent uses it as system prompt)
Agent calls sprintengine.subscribe(agent_id)
  → records polling or compatible notification subscription metadata
  → agent is now idle, waiting for dispatch through CLI watch or MCP reads

[Time passes. Work lands. Server's scheduler picks this agent for a task or gate.]

Server records dispatch target { agentId, target: { taskId | gateId, role, reason } }
  → server has already recorded the assignment in the folder store
Multicode observes dispatch/state change and wakes or focuses the target terminal
Agent receives the directive through the terminal/session path
Agent does its work, calling MCP tools to read task details, write comments, log evidence
Agent calls sprintengine.task.publish or sprintengine.gate.publish when done
  → server records the verdict, advances state per progression rules, dispatches next agent
Agent returns to idle, subscription stays open

[On graceful shutdown:]
Agent calls sprintengine.agent.leave(agent_id)
  → server releases any claims, removes from agents map
```

Multicode-launched autonomous agents now start and continue through the managed `multicode-sprintengine` MCP server. They register with `sprintengine.agent.join`, fetch work with `sprintengine.agent.next_directive`, and invoke the returned MCP tool once. Multicode, not the CLI, owns later terminal wake/resume and replacement spawning. `sprintengine join --role <role> --id <agent-id> --watch` remains a standalone/headless CLI compatibility path that shares lifecycle records and owns its own polling/backoff.

**Scheduling policy**: round-robin among idle agents of the requested role. Future refinements can include affinity-aware re-dispatch for rework loops and user-pinned filters.

**Liveness**: heartbeat-backed. Agents refresh `heartbeatAt` through lifecycle calls such as `sprintengine.agent.heartbeat`, `agent.join`, and compatibility join/task paths. Expiry uses the run policy `agentTimeoutSeconds` value from run metadata or runner metadata; the implemented default is 300 seconds when no positive override is configured. When an agent expires, the server marks it `dead`, releases claims, and makes the work available for re-dispatch. (Future v2 refinement: hybrid liveness — Multicode signals death immediately via `agent.leave` on pty exit, with heartbeat as a backstop.)

### Server-driven progression

The server does everything that's a deterministic function of state. The architect does everything that requires understanding what the work *means*.

**Server handles automatically:**

- All required gates approved on a task → task transitions to `done`.
- A gate verdict of `changes_requested` → task transitions back to `changes_requested` status, rework gate(s) reset, server dispatches the task's assigned role for rework.
- Task dependencies satisfied → task becomes `ready` and joins the dispatchable queue.
- A task with `needsTriage: true` stays in `todo` and is not claimable until the architect reviews it, removes duplicates or irrelevant work, sets the role/acceptance/gates as needed, and clears `needsTriage`.
- Agent dies (no heartbeat) → server releases the agent's claims, re-dispatches the work.
- Implementation tasks all `done` + run policy includes final reviews → server dispatches the architect with a "schedule final reviews" task.
- Final review evidence available → server dispatches the architect with a "sign off or schedule further work" task.

**Architect handles (server dispatches it when judgment is needed):**

- Initial plan generation (build the task graph, set dependencies, attach gates).
- Triage for intake-created candidate tasks: choose the role, tighten acceptance criteria, attach gates, delete duplicates or irrelevant tasks, and clear `needsTriage` when the task is ready for normal dependency-based dispatch.
- Deciding which gates apply per task. The `appliesWhen` schema was deliberately not built — the architect decides at plan time based on paths, scope, risk, and the current roster.
- Setting acceptance criteria and notes on each task.
- Reviewing a `changes_requested` verdict and deciding if the rework is straightforward (rework gate handles it) or if new follow-up tasks are needed.
- Final signoff.

**Key shift**: the architect can become a continuously-present worker, but the runtime must not rely on MCP notifications alone to resume it. The architect joins like every other role, the server records when architect judgment is needed, and Multicode wakes or focuses the terminal/session so the architect receives the directive.

## Schema

### Role manifest

```jsonc
{
  "id": "developer",
  "label": "Developer",
  "aliases": [],
  "summary": "Builds core logic, integrations, and refactors.",
  "icon": "code",

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

  "soul": [
    { "skill": "senior-reviewer-identity" },
    { "skill": "code-review-rubric" },
    { "skill": "ai-slop-detection" },
    { "skill": "evidence-quality-assessment" },
    { "skill": "post-change-self-review" }
  ]
}
```

**Architect example:**

```jsonc
{
  "id": "architect",
  "label": "Architect",
  "aliases": [],
  "summary": "Plans the work, owns dependencies, schedules final reviews, signs off.",
  "icon": "architecture",

  "soul": [
    { "skill": "architect-identity" },
    { "skill": "task-graph-design" },
    { "skill": "quality-gate-selection" },
    { "skill": "final-review-scheduling" },
    { "skill": "dispatch-response-protocol" },
    { "skill": "risk-workflow" },
    { "skill": "post-change-self-review" }
  ]
}
```

**Canonical id**: `architect`.

### Role semantics

Role manifests do not declare hard capability switches such as `implementer.enabled`, `gate.enabled`, or `canReviewPlans`. A role is a named specialist with display metadata and a composed Soul. Sprint Engine routing is driven by the work item, not by role-type flags.

Dispatch targets define the mode of work:

- Normal task work: `task.role` names the role that should receive the task.
- Review, testing, and product work: a task `qualityGates[]` entry names the `role`, `phase`, `focus`, `artifactKind`, and `allowSelfReview` for that gate.
- Architect judgment work: server-created architect targets use `role: "architect"` and a judgment-specific target kind/reason.

Any configured role can be assigned to normal tasks or quality gates. A "review-only" role is review-only because the architect only creates review/test/product gates for that role, not because the role manifest blocks normal task assignment. A marketing role is just another role; it can receive normal tasks, review gates, or both if the architect plans that way.

Coordination prompts are selected from the dispatch target, not from role capabilities:

- Normal task dispatch → task-worker Sprint Engine coordination prompt.
- Review phase gate dispatch → review-gate coordination prompt.
- Testing phase gate dispatch → testing-gate coordination prompt.
- Product phase gate dispatch → product-gate coordination prompt.
- Architect judgment dispatch → architect coordination prompt.

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

Entry shape for v1 is skill-only:

- `{ "skill": "<id>" }` — resolve `id` against the search path, read `SKILL.md`, strip frontmatter, append body

Inline text entries such as `{ "text": "<inline string>" }` are deferred. The
current validator rejects them with `invalid_soul_entry` so docs, CLI
validation, MCP registry payloads, and prompt rendering all agree on one
supported shape.

The renderer concatenates resolved entries with `\n\n` between them. The result is the Soul prompt the agent receives via `sprintengine.soul.get(role)`.

Sprint Engine coordination prompts remain a separate Sprint Engine-owned layer. They are not soul skills. The effective runtime prompt is:

1. Composed Soul prompt from the role registry.
2. Sprint Engine coordination prompt selected from the role manifest behavior.
3. Runtime directive from MCP dispatch or the active task/gate payload.

### Search path

Highest precedence wins. Each layer scans for `roles/<id>.json` and `skills/<id>/SKILL.md`.

| Layer | Path | Configured by |
|---|---|---|
| Workspace-local | `<workspace>/.sprintengine/{roles,skills}/` | Workspace owner; project-specific overrides |
| Plugin-scoped | varies by plugin | Multicode passes `--extra-dir <plugin>/.sprintengine` or another plugin registry root containing `roles/` and `skills/` when launching the server |
| User | `~/.sprintengine/{roles,skills}/` | User; personal overrides across all workspaces |
| Bundled | `resources/sprintengine/{roles,skills}/` (in Multicode) or the equivalent in standalone Sprint Engine | Ships with Sprint Engine |

**Conflict resolution**: first match wins by precedence. Overriding bundled roles is allowed by design. The registry should expose the winning source layer and shadowed lower-precedence source in discovery responses so the UI can show where a role came from.

Role manifests describe role identity and prompt composition. Work routing comes from tasks, quality gates, and server-created architect targets. CLI spawning defaults, permission presets, MCP server configuration, and provider-specific runtime settings stay in the BYO-CLI/plugin/runtime configuration layer rather than in the role manifest.

## File locations

```
resources/sprintengine/                # bundled (ships with Sprint Engine)
  roles/
    architect.json
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

Final MCP names use dotted, role-agnostic operation groups. The old CLI-shaped MCP tools remain compatibility aliases for standalone/headless CLI and transition tests; Multicode-launched autonomous agents should use the managed MCP runtime and structured directive tools.

`sprintengine_mcp/schemas.py` exposes the final v1 contract schemas separately from the active `TOOL_SCHEMAS` registry. The live MCP `list_tools` response must advertise only tools with server handlers; future contract names move into `TOOL_SCHEMAS` as their handlers land.

| Area | Final v1 names | Compatibility aliases and notes |
|---|---|---|
| Agent lifecycle | `sprintengine.agent.join`, `sprintengine.agent.heartbeat`, `sprintengine.agent.leave`, `sprintengine.subscribe` | `sprintengine.join` is a compatibility alias for CLI `join --watch`. It accepts `role`, `id`, `watch`, and `maxWaitSeconds`, returns the existing join directive shape, and records the same lifecycle fields as `sprintengine.agent.join`. |
| Dispatch observation | `sprintengine.dispatch.next`, `sprintengine.dispatch.ack`; optional server notifications `sprintengine.dispatch`, `sprintengine.cancel`, `sprintengine.run.status_changed` | `dispatch.next` returns the agent's `currentDispatch`, state, and only that agent's ledger entries, with `lastDispatchId` pagination applied after agent filtering. Dispatch records are durable state, not a wake-up guarantee. Multicode still owns terminal spawn/focus/input wake-up for current CLIs. |
| Discovery | `sprintengine.roles.list`, `sprintengine.roles.get`, `sprintengine.soul.get`, `sprintengine.skills.list`, `sprintengine.skill.get` | Discovery reads the role registry and Soul renderer; it must expose source layer and warnings where available. |
| Task operations | `sprintengine.task.get`, `sprintengine.task.list`, `sprintengine.task.next`, `sprintengine.task.claim`, `sprintengine.task.status`, `sprintengine.task.resolve_input`, `sprintengine.task.release`, `sprintengine.task.ready`, `sprintengine.task.log`, `sprintengine.task.note`, `sprintengine.task.comment`, `sprintengine.task.comment.list`, `sprintengine.task.publish`, `sprintengine.task.request_changes` | Active MCP names are role-agnostic and call the same core mutation path as the CLI. Claim responses include `currentDispatch` and a top-level dispatched state when a durable assignment exists. Completion-style responses include progression data where server progression advanced the task. |
| Gate operations | `sprintengine.gate.list`, `sprintengine.gate.next`, `sprintengine.gate.claim`, `sprintengine.gate.verdict`, `sprintengine.gate.publish`, `sprintengine.gate.skip` | Gate claim responses include `currentDispatch` and top-level dispatched state for the claimed gate. `gate.publish` is the final v1 verdict name; `gate.verdict` remains the CLI-compatible wrapper. |
| Artifact operations | `sprintengine.artifact.add`, `sprintengine.artifact.ready`, `sprintengine.artifact.approve`, `sprintengine.artifact.request_changes`, `sprintengine.artifact.list` | Artifact paths remain project-root-relative. Explicit UI review actions may call authenticated main/MCP IPC for approval or request-changes, but the mutation authority remains Sprint Engine core/MCP rather than agent terminal text or direct store writes. |
| Plan operations | `sprintengine.plan.add_task`, `sprintengine.plan.update_task`, `sprintengine.plan.delete_task`, `sprintengine.plan.add_dependency`, `sprintengine.plan.remove_dependency`, `sprintengine.plan.start_review`, `sprintengine.plan.review_status`, `sprintengine.plan.address_reviews` | Architect-only mutating operations continue to enforce actor/role authorization. |
| Run operations | `sprintengine.run.get`, `sprintengine.run.policy.get`, `sprintengine.run.projection`, `sprintengine.run.subscribe` | `sprintengine.summary`, `sprintengine.health`, roster tools, and feedback tools remain operational/support tools. |

### Agent lifecycle

External/debug MCP callers can pass `statePath` for stateful lifecycle calls
and `workspaceRoot` for registry discovery calls. Multicode-launched autonomous
agents use the managed MCP server launch context instead, so their prompt
payloads omit these server-resolvable path fields.

- `sprintengine.agent.join(statePath, role, agentId, workspaceRoot?, subscribe?, subscriptionMode?) → { agentId, role, agent, currentDispatch, run, roleManifest, prompt, promptContext, legacyJoin }`
- `sprintengine.agent.heartbeat(statePath, agentId)`
- `sprintengine.agent.leave(statePath, agentId, reason?)`
- `sprintengine.subscribe(statePath, agentId, transport?, lastDispatchId?)` — records dispatch subscription metadata for polling or compatible MCP notifications
- `sprintengine.join(statePath, role, id, watch?, maxWaitSeconds?)` — CLI `join --watch` compatibility response shape

### Dispatch ops

- `sprintengine.dispatch.next(statePath, agentId, lastDispatchId?) → { currentDispatch, dispatches, state }`
- `sprintengine.dispatch.ack(statePath, agentId, dispatchId, outcome?) → { agent, currentDispatch }`

`currentDispatch` is the active target mirror on the agent record. It carries `dispatchId`, `targetKind`, `role`, `reason`, `assignedAt`, and target identifiers such as `taskId`, `gateId`, and `attemptId`. Agents must reconcile by `dispatchId` before acting after reconnects.

### Server → agent notifications

- `sprintengine.dispatch { dispatchId, agentId, target: { kind, taskId?, gateId?, role, reason } }` — server has assigned this agent
- `sprintengine.run.status_changed { workspaceRoot, status }` — informational
- `sprintengine.cancel { agentId, reason }` — server is revoking the agent's current claim

Notifications are advisory transport. The durable contract is `run.yaml` plus `dispatch.jsonl`: if a notification is missed, duplicated, or delivered after reconnect, the receiving agent must reconcile by dispatch id before acting. Current production behavior must not assume that a notification wakes an idle Codex or Claude Code session.

Artifact review follows the same state-first rule. Approval, request-changes,
and policy-approved auto-approval are recorded by Sprint Engine artifact
operations, then renderer/runtime consumers react to the returned projection,
events, dispatch, or notification state. Multicode may wake or focus an agent
terminal after that state exists; it must not make terminal text the normal
artifact review mutation path.

### Discovery

- `sprintengine.roles.list(workspaceRoot) → [<role-manifest>, ...]`
- `sprintengine.roles.get(workspaceRoot, roleId) → <role-manifest>`
- `sprintengine.soul.get(workspaceRoot, roleId) → <composed-prompt-string>`
- `sprintengine.skills.list(workspaceRoot) → [<skill-summary>, ...]`
- `sprintengine.skill.get(workspaceRoot, skillId) → { frontmatter, body }`

### Task ops

- `sprintengine.task.get(statePath, taskId) → <task>`
- `sprintengine.task.list(statePath, role?, status?, includeDone?) → [<task>, ...]`
- `sprintengine.task.next(statePath, role, id)`
- `sprintengine.task.claim(statePath, taskId, id)`
- `sprintengine.task.status(statePath, taskId, status, id, summary?, needsInput*)`
- `sprintengine.task.resolve_input(statePath, taskId, id, resolution, complete?)`
- `sprintengine.task.release(statePath, taskId, id, reason)`
- `sprintengine.task.ready(statePath, taskId, id, triagedBy?)`
- `sprintengine.task.log(statePath, taskId, id, summary?, file?, command?, result?, scopeExpansionJson?)`
- `sprintengine.task.note(statePath, taskId, id, note)`
- `sprintengine.task.comment(statePath, taskId, id, body, source?, commentType?, paths?, data?)`
- `sprintengine.task.comment.list(statePath, taskId) → [<comment>, ...]`
- `sprintengine.task.publish(statePath, taskId, id, summary, path?, file?, data?, summaryDataJson?)`
- `sprintengine.task.request_changes(statePath, taskId, id, reason, source?, paths?, needsInput*)`

### Gate ops

- `sprintengine.gate.list(statePath, taskId?, phase?, role?) → [<gate>, ...]`
- `sprintengine.gate.next(statePath, role, id)`
- `sprintengine.gate.claim(statePath, taskId, gateId, role, id)`
- `sprintengine.gate.verdict(statePath, taskId, gateId, role, id, verdict, summary, requiredAction?, artifact*, needsInput*)`
- `sprintengine.gate.publish(statePath, taskId, gateId, role, id, verdict, summary, requiredAction?, artifact*)`
- `sprintengine.gate.skip(statePath, taskId, gateId, role, id, rationale)`

### Artifact ops

- `sprintengine.artifact.add(statePath, taskId, kind, title, path, actor?, artifactId?, createdBy?, recommendedTask?, ready?)`
- `sprintengine.artifact.list(statePath, taskId?, kind?, status?) → [<artifact>, ...]`
- `sprintengine.artifact.ready(statePath, artifactId, id)`
- `sprintengine.artifact.approve(statePath, artifactId, id)`
- `sprintengine.artifact.request_changes(statePath, artifactId, id, feedback)`

### Architect ops

- `sprintengine.plan.add_task(statePath, title, role, actor?, taskId?, description?, dependsOn?, path?, acceptance?, note?, taskNote?, requireGate?, skipGate?, manualDispatch?)`
- `sprintengine.plan.update_task(statePath, taskId, actor?, title?, description?, role?, path?, acceptance?, note?, taskNote?, requireGate?, skipGate?)`
- `sprintengine.plan.delete_task(statePath, taskId, actor?, unlinkDependents?)`
- `sprintengine.plan.add_dependency(statePath, taskId, dependsOn, actor?)`
- `sprintengine.plan.remove_dependency(statePath, taskId, dependsOn, actor?)`
- `sprintengine.plan.start_review(statePath, role, id)`
- `sprintengine.plan.review_status(statePath) → <summary>`
- `sprintengine.plan.address_reviews(statePath, actor?)`

### Run ops

- `sprintengine.run.get(statePath) → <run.yaml content>`
- `sprintengine.run.policy.get(statePath) → { runner: <normalized runner policy> }`
- `sprintengine.run.projection(statePath) → <projection.json content>`
- `sprintengine.run.subscribe(statePath, lastEventId?, transport?)` — UI subscription for state changes

### `sprintengine.join` compatibility test contract

During the transition, `sprintengine.join` is not an independent lifecycle design. Tests must prove that it remains behavior-compatible with the new lifecycle path:

- Joining with `role` and `id` records or refreshes the same agent identity fields as `sprintengine.agent.join`.
- A resumed agent receives its active task or gate before new work.
- A duplicate join does not create a duplicate dispatch assignment or second ledger record for the same target.
- When Auto Mode is off and no target is available, the compatibility response returns idle without mutating task ownership.
- When Auto Mode is on, CLI polling/backoff remains a Multicode wake/resume mechanism; MCP notification support is not required for the test to pass.

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
- `dispatch-response-protocol` — how to handle a server-dispatched task vs architect-self-initiated work (new, written for the architect)

### Per-role identity skills

Each role gets its own identity skill capturing the role-specific persona:

- `architect-identity`, `principal-engineer-identity`, `senior-reviewer-identity`, `senior-tester-identity`, `senior-product-strategist-identity`, `frontend-engineer-identity`, `devops-engineer-identity`, `security-specialist-identity`, `performance-engineer-identity`, `blog-writer-identity`, `presentation-author-identity`, `coordinator-identity`, `spec-reviewer-identity`

### Role-specific skills

Where a section is unique to one role and not shared, it becomes a role-specific skill. Examples:

- `task-graph-design` (architect only)
- `quality-gate-selection` (architect only)
- `final-review-scheduling` (architect only)
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
3. Author the manifest with `id`, `label`, `summary`, `icon`, aliases if needed, and the soul array.
4. Sanity-check the composed output: render the soul through the new path and diff against today's monolithic prompt. Where there's drift, decide whether to update the new version (because today's prose was outdated) or restore the prose (because the new composition lost meaning).

## Implementation phases

Each phase is independently shippable and leaves the system in a working state.

## Work package breakdown

Use these packages as the task graph. The dependencies are about implementation order, not compatibility.

### WP0 — MCP wake-up feasibility

**Goal:** Prove whether the desired notification-driven runtime is technically possible before rewriting the runner.

**Current status, 2026-05-19:** Design revision required. The isolated harness can emit a delayed server-originated notification, but Codex 0.130.0 timed out during MCP startup against the harness and Claude Code 2.1.144 closed stdin before `initialize`/failed health checks. No required real target CLI proved `direct_mcp_wake` or `terminal_input_required`. Treat direct MCP wake-up as unsupported for current planning and revise WP6/WP7 around Multicode-managed terminal/session wake-up.

**Owns:** `sprintengine_mcp/`, a small feasibility harness under `tests/` or `validation/`, notes in this design doc.

**Work:**

- Create a minimal local MCP server notification experiment.
- Test Codex, Claude Code, and any BYO-CLI target expected to run Sprint Engine agents.
- Record whether server notifications can wake/resume an idle model session, whether Multicode must inject terminal input, or whether the CLI cannot support the model.

**Acceptance:** The doc records a clear yes/no per CLI and the runtime design is either confirmed or revised before WP6/WP7 begin.

### WP1 — Role and skill registry core

**Goal:** Build the registry and Soul renderer without touching runtime dispatch.

**Owns:** `sprintengine_core/roles.py` or equivalent new module, `resources/sprintengine/`, Python tests.

**Work:**

- Define role manifest and skill frontmatter schemas.
- Implement search paths: workspace, plugin, user, bundled.
- Implement validation, source-layer reporting, shadow reporting, alias resolution, and composed Soul rendering.
- Implement safe variable substitution for the allow-listed variables.

**Acceptance:** Unit tests prove role loading, override precedence, broken-entry skipping, alias resolution, frontmatter stripping, and composed output.

### WP2 — CLI and Souls compatibility surface

**Goal:** Make humans and existing tooling inspect the new registry.

**Owns:** `scripts/souls*`, `souls/`, `scripts/sprintengine_tool.py`, `sprintengine_core/tool.py` command wiring, docs.

**Work:**

- Back `souls list/get/path/validate` with the new registry.
- Add `sprintengine roles list`, `sprintengine role get`, `sprintengine soul get`, `sprintengine skill list`, and `sprintengine skill get`.
- Keep output stable enough for humans and tests, but do not preserve old internals.

**Acceptance:** CLI tests cover bundled role lookup and a temporary custom role under `~/.sprintengine` or a test workspace path.

### WP3 — Bundled role migration

**Goal:** Move the 13 bundled monolithic Souls into manifests and composable skills.

**Owns:** `resources/sprintengine/roles/`, `resources/sprintengine/skills/`, `souls/prompts/`, migration notes.

**Work:**

- Extract shared skills and role-specific identity/rubric skills.
- Author one manifest per bundled role.
- Render each composed Soul and compare against the old prompt.
- Record intentional drift decisions.
- Remove the old hardcoded `SOULS` prompt source once the new path is active.

**Acceptance:** `souls validate` and registry tests pass; rendered bundled Souls are reviewed against old prompts with drift notes.

### WP4 — Sprint Engine role-agnostic core

**Goal:** Remove hardcoded role enums from Sprint Engine planning, task, gate, and roster logic.

**Owns:** `sprintengine_core/tool.py`, `sprintengine_core/store.py`, `docs/sprintengine-schema.md`, backend tests.

**Work:**

- Replace `VALID_ROLES` checks with registry-backed role validation where validation is needed.
- Let task roles and gate roles be configured role strings.
- Add `needsTriage` task field with default `false`; exclude `needsTriage: true` tasks from claim/dispatch readiness while keeping them visible in `todo`.
- Keep role manifests free of capability flags; route by task/gate target.

**Acceptance:** Tests prove a custom role can appear in roster, receive a normal task, receive a review gate, and that `needsTriage: true` blocks dispatch until cleared.

### WP5 — MCP registry and operation API

**Goal:** Expose the registry and Sprint Engine operations over MCP as the machine interface.

**Owns:** `sprintengine_mcp/`, `scripts/sprintengine_tool.py`, MCP schema/tests.

**Work:**

- Add MCP discovery tools for roles, skills, and Souls.
- Add or normalize task, gate, artifact, plan, and run tools around the new role-agnostic model.
- Align payload naming on `workspaceRoot` or the chosen run locator consistently.
- Add auth/path checks for workspace/user/plugin registry reads.

**Acceptance:** MCP tests prove discovery and mutation paths work for bundled and custom roles.

### WP6 — Agent lifecycle, dispatch, and liveness

**Goal:** Implement server-side assignment and agent lifecycle state.

**Owns:** `sprintengine_mcp/`, `sprintengine_core/store.py`, run-store schema/tests.

**Work:**

- Add `agent.join`, `agent.heartbeat`, `agent.leave`, and subscription support.
- Add `run.yaml` agent records with current dispatch target, heartbeat, subscription, and status fields.
- Add `dispatch.jsonl` plus idempotent dispatch ids/target records.
- Implement round-robin dispatch among idle agents for the requested role.
- Implement dead-agent release and re-dispatch.

**Acceptance:** Tests prove no duplicate assignment on retry/reconnect, dead agents release claims, and dispatch ledger/projection state stays coherent.

### WP7 — Runtime and renderer integration

**Goal:** Make Multicode use the notification-driven Sprint Engine runtime.

**Owns:** `src/main/`, `src/preload/`, `src/renderer/src/`, app tests.

**Work:**

- Start/host the local Sprint Engine MCP server for workspaces.
- Replace output-sentinel/process-output completion with state/MCP notifications.
- Spawn/focus terminals based on dispatch events.
- Replace hardcoded renderer role unions/maps with registry-driven role lists where Sprint Engine needs extensibility.
- Add role settings UI for listing roles, source layer, enable/disable, and install-from-folder.

**Acceptance:** App tests or manual validation prove a custom role appears in the roster/UI and can run through dispatch without stdout sentinels.

### WP8 — End-to-end validation and cleanup

**Goal:** Prove the final product path and remove dead old paths.

**Owns:** Cross-cutting tests, docs, obsolete prompt/role paths.

**Work:**

- Run an end-to-end dogfood sprint with a custom role such as `marketer`.
- Validate normal task dispatch, review gate dispatch, product/test gate dispatch, `needsTriage`, architect judgment dispatch, dead-agent recovery, and final review scheduling.
- Remove obsolete hardcoded role constants, old prompt loaders, stale state references, and sentinel assumptions.
- Update `docs/souls.md`, `docs/sprintengine-schema.md`, and `knowledge/multicode/sprint-engine.md`.

**Acceptance:** Success criteria in this doc pass against real Sprint Engine state, not fixtures or disconnected UI state.

### Phase 0 — MCP notification feasibility checkpoint

- Test whether each target CLI can be woken or resumed by MCP server notifications while an agent is idle.
- Test Codex, Claude Code, and any BYO-CLI integration points that are expected to participate in Sprint Engine.
- Record the exact supported pattern per CLI: server notification wakes model, runtime must inject terminal input, or unsupported.
- If direct MCP wake-up is unsupported, stop and revise this design before continuing the runtime rewrite.
- As of the 2026-05-19 revalidation pass, protocol notification delivery is verified only outside target CLIs. Codex and Claude Code did not complete a connected idle MCP session with the harness, so runtime work must proceed only with a revised design where Multicode wakes or focuses agent terminals and MCP notifications/state are not the sole wake mechanism.

### Phase A — Schema, search path, and soul-skill composition mechanic

- Define the role-manifest schema (TypeScript types + JSON Schema + Python dataclasses).
- Define the skill folder format and frontmatter conventions.
- Build the soul renderer: takes a manifest + workspace path + search-path config → composed prompt string. Pure function in `sprintengine_core`, fully unit-tested.
- Build the registry loader: scans the search-path layers, validates manifests and skill folders, surfaces broken entries as warnings (skipped, not fatal).
- New `sprintengine` CLI commands for humans: `sprintengine roles list`, `sprintengine role get`, `sprintengine soul get`, `sprintengine skill list`, `sprintengine skill get`. These exercise the registry through the same library agents will use via MCP.
- New mechanic available and covered before it becomes the active prompt path.

### Phase B — Extract shared skills, migrate the 13 bundled roles

- Author the shared skill files (`risk-workflow`, `avoid-ai-slop`, `no-mock-runtime`, etc.) in `resources/sprintengine/skills/`.
- Author the per-role identity skills and role-specific skills.
- Author the 13 role manifests in `resources/sprintengine/roles/`.
- Diff each composed output against today's prompt; resolve drift.
- Delete `souls/prompts/<role>.md` and the `souls/registry.py:SOULS` hardcoded tuple. The Python `souls` CLI continues to work but is a thin wrapper around the new registry.

### Phase C — MCP server scaffolding and agent lifecycle

- Sprint Engine MCP server gains the agent-lifecycle tools (`agent.join`, `agent.heartbeat`, `agent.leave`, `subscribe`) and the discovery tools (`roles.list`, `roles.get`, `soul.get`, `skills.list`, `skill.get`).
- Server tracks agents in `run.yaml`'s agents map with lifecycle fields such as `status`, `heartbeatAt`, `subscription`, `currentDispatch`, `currentTaskId`, `currentGate`, `currentGateId`, `joinedAt`, and `lastDirectiveAt`.
- Optional notification machinery (server → compatible subscribed clients): the server can expose `sprintengine.dispatch`, `sprintengine.cancel`, and `sprintengine.run.status_changed` events, but production runtime correctness must not depend on those notifications waking Codex or Claude Code.
- A reconciliation tick detects agents past the configured `agentTimeoutSeconds` liveness timeout, defaulting to 300 seconds when no positive override is configured, then releases their claims and marks them dead.

### Phase D — Server-side dispatch + state-driven progression

- Scheduler implementation: round-robin among idle agents of the requested role.
- Dispatch ledger (`dispatch.jsonl`) appended on every assignment.
- Server-driven state transitions:
  - All gates approved → task `done`.
  - Gate `changes_requested` → task `changes_requested`, rework gate reset, re-dispatch the task's assigned role.
  - Implementation tasks `done` + run policy requires final reviews → dispatch architect with "schedule final reviews."
  - Final review evidence available → dispatch architect with "sign off or schedule more work."
- Architect prompt rewritten: agent uses MCP, responds to dispatches, no longer remembers lifecycle rules. New `dispatch-response-protocol` skill in the architect's soul.

### Phase E — Task/gate/artifact ops via MCP, runtime integration

- Full MCP tool surface (task ops, gate ops, artifact ops, architect/plan ops) — all behavior the CLI does, exposed as MCP tools.
- Multicode runtime: keeps terminal/session orchestration as the wake/resume authority. It may read `projection.json`, server dispatch state, and compatible MCP notifications as input signals, but it must spawn, focus, or inject terminal directives itself when work is assigned.
- Renderer: subscribes to MCP `run.subscribe` for reactive state. Drops `Record<SprintEngineRole, X>` patterns in favour of registry-driven maps.
- Removal of the legacy `--print` / output-sentinel / state.yaml code paths (already gone on main, but verify nothing crept back).

### Phase F — Settings UI for roles + plugin-scoped skills + standalone polish

- Settings UI "Roles" tab: lists installed roles, enable/disable per-workspace, and install-from-folder.
- Plugin manifest's existing `souls.directory` hook wired so a CLI plugin can ship `<plugin-root>/sprintengine/{roles,skills}/`.
- Standalone Sprint Engine packaging polish: the `sprintengine mcp serve` command works without Multicode, ships with the same bundled content, accepts `--user-dir`, `--workspace`, `--extra-dir` flags.

## Settings UI scope (v1)

The "Roles" tab in Settings:

- Lists installed roles (bundled + user + plugin-scoped) with their `label`, `summary`, `icon`, source layer, and enable/disable toggle.
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
    status: idle              # idle | running | needs_input | left | dead | retired
    currentTaskId: null
    currentGate: null
    currentGateId: null
    currentDispatch: null
    heartbeatAt: 2026-05-18T10:23:14Z
    subscription:
      mode: poll              # none | poll | mcp_notifications
      subscribedAt: 2026-05-18T10:00:00Z
      lastDispatchId: DISP-abc123
    joinedAt: 2026-05-18T10:00:00Z
    lastDirectiveAt: 2026-05-18T10:23:14Z
```

**Task records** gain optional candidate-intake gating:

```jsonc
{
  "id": "T12",
  "role": "developer",
  "status": "todo",
  "needsTriage": true
}
```

`needsTriage` defaults to `false` when absent. Candidate tasks created by intake/review agents set it to `true`; these tasks stay visible in `todo` but are not claimable or dispatchable until the architect clears the flag or deletes the task.

**New file `dispatch.jsonl`** (append-only, sibling of `events.jsonl`):

```jsonl
{"id":"DISP-gate-frontend-2-G3-GA-001","timestamp":"2026-05-18T10:01:23Z","agentId":"frontend-2","role":"frontend","target":{"kind":"gate","taskId":"T4","gateId":"G3","attemptId":"GA-001"},"reason":"gate_claimed","state":{"taskStatus":"review","gateStatus":"in_progress"},"outcome":"dispatched","source":"core"}
{"id":"DISP-task-developer-1-T5-rework","timestamp":"2026-05-18T10:02:45Z","agentId":"developer-1","role":"developer","target":{"kind":"task","taskId":"T5"},"reason":"changes_requested_rework","state":{"taskStatus":"changes_requested","gateStatus":null},"outcome":"dispatched","source":"core"}
```

Useful for replay, debugging round-robin, and analytics later.

## Multiloop

Parked for this work. Multiloop is its own workspace mode, not finished, and overlaps conceptually but doesn't share lifecycle code with Sprint Engine. A dedicated fix-up task should follow this work to either bring multiloop into the same registry + dispatch model or sunset it cleanly. Adding a `future-plans/2026-05-18-multiloop-fix-up.md` placeholder so it doesn't get lost.

## Open questions

A few small decisions to revisit during implementation, called out so they're not forgotten:

- **MCP transport details.** Stdio for the local server is the convention. If a future remote-MCP catalog feature lands (for role/skill content distribution), it would use SSE or HTTP-streaming; out of scope for this work.
- **MCP wake-up feasibility.** We want agents to be woken by MCP server notifications, but this is not yet proven across the CLIs Sprint Engine needs to support. Phase 0 confirms the real client behavior before the runtime rewrite proceeds.
- **Recovery from server crash.** Currently the server holds dispatch state in memory plus what's in the folder store. On restart, it reads the run files and re-computes the agent registry from `agents` map. Unclaimed in-flight dispatches are re-emitted to subscribed agents if subscriptions are proven. Detailed sequence to nail down during implementation.
- **Subscription persistence across reconnect.** When an agent's MCP client reconnects after a transient drop, it should re-issue `subscribe` and the server should resume sending notifications if the protocol/client behavior supports it.
- **Editorial drift detection.** When migrating each of the 13 souls, the diff between the old monolithic prompt and the new composed output may reveal outdated prose that needs to be either updated or restored. Track each diff decision in a `MIGRATION-NOTES.md` per role for posterity.
- **AgentCli generalisation** (BYO-CLI Phase 2e — `AgentCli = 'codex' | 'claude'` → `string`). Still pending; doesn't block this work; can be done in parallel.

## Non-goals

- **Multiloop refactor.** Parked, separate task.
- **Authoring UI** (drag-and-drop role/soul composer). Defer to v2.
- **Remote MCP catalog or URL install** for role/skill distribution. Users provide local role/skill folders; Sprint Engine validates them against the schema.
- **Sprint Engine physical extraction** into a standalone package. The design supports it; doing the actual git/PyPI extraction is a separate operational task.
- **Performance benchmarking** of MCP round-trips vs CLI shell-out. Assumed fine; revisit if profiling shows otherwise.
- **Codex Windows path migration** (BYO-CLI follow-up — `-C cwd`, npm-shim, prompt escaping). Independent.

## Success criteria

When this work ships:

1. A user can drop `~/.sprintengine/roles/marketer.json` referencing `~/.sprintengine/skills/brand-voice/SKILL.md` and a few shared skills, and the architect can assign marketing tasks to that role just like assigning to `developer`.
2. The Settings UI "Roles" tab shows the new role alongside bundled ones.
3. An agent spawned for the marketer role calls `sprintengine.agent.join`, gets its composed Soul and Sprint Engine coordination prompt, sits idle until dispatch, does the work, publishes via MCP, and returns to idle.
4. The roster and task graph accept configured role strings instead of a hardcoded role enum.
5. Intake/review-created candidate tasks can set `needsTriage: true`, remain visible in `todo`, and do not dispatch until the architect clears the flag or deletes them.
6. The architect agent stays alive across the whole run, gets dispatched for planning, triage, review-follow-up decisions, final-review scheduling, and signoff.
7. The runtime no longer watches pty output for completion signals. It listens to MCP `run.subscribe` events for state changes and manages terminal lifecycle from those.
8. No `state.yaml` files written. No `[sprint-engine:done]` sentinels. No shell-quoted `souls get developer` invocations from agents.
9. The CLI continues to work for humans (`sprintengine plan add-task`, task/gate/artifact commands, etc.) on top of the same registry-backed role model.
