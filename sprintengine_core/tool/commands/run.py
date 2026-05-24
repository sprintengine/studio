"""Sprint Engine run command handlers."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.tool.artifacts import artifacts_for_task, file_fingerprint, next_artifact_id, project_relative_display_path
from sprintengine_core.tool.gates import find_active_gate_claim, gate_is_claimable_for_role
from sprintengine_core.tool.paths import now_iso, sprintengine_state_path_for
from sprintengine_core.tool.plans import (
    build_run_summary,
    default_swarm_name_for_state,
    ensure_plan_approval_gate,
    ensure_product_intake_gate,
    find_architect_plan_gate,
    handover_path_for_state,
    import_source_to_team_file,
    parse_source_bundle_arg,
    plan_path_artifact_value,
    plan_path_for_state,
    product_intake_path_artifact_value,
    refresh_artifact_fingerprint,
    safe_source_filename,
    slugify_team_name,
    source_bundle_reference_notes,
    sources_dir_for_state,
    state_has_source_kind,
)
from sprintengine_core.tool.prompts import artifact_registration_instruction, completion_reality_instruction, load_prompt
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.review_prompts import build_merge_start_prompt, worker_execution_workspace_block
from sprintengine_core.tool.state import (
    agent_is_retired,
    append_event,
    apply_agent_specs,
    ensure_agent_in_roster,
    load_mutation_state,
    parse_agent_specs,
    reconcile_agent,
    release_expired_agent_targets,
    roster_is_configured,
    roster_roles,
    task_quality_gates,
    with_locked_state,
)
from sprintengine_core.tool.tasks import add_unique_values, recompute_phase, task_is_ready

BENCHMARK_FEEDBACK_GUIDANCE = (
    "Benchmark feedback counts are evidence fields, not guesses. "
    "`claims_checked` is the number of concrete implementation, spec, evidence, or verification claims you actually checked. "
    "`hallucinated_claims` counts checked claims unsupported by the repo, task card, evidence, or observed behavior. "
    "`factual_errors` counts checked claims contradicted by source or runtime evidence. "
    "`missed_requirements` counts required acceptance or plan items absent or only partially implemented. "
    "`implementation_mistakes` counts code, state, schema, routing, or integration defects in the delivered work. "
    "`regression_count` counts previously working behavior that the change breaks. "
    "`test_failures_introduced` counts new failing tests or reproducible validation failures caused by the change. "
    "`unsafe_changes` counts changes that create security, data-loss, destructive-operation, privacy, or permission risk. "
    "Leave fields unset when you did not evaluate them."
)

DIFFICULTY_FEEDBACK_GUIDANCE = (
    "Use difficulty percentages only when you assessed the work: architects may estimate task difficulty with "
    "`--difficulty-pct` and `--difficulty-reason`; implementers may report actual difficulty at publish/done time with "
    "`--actual-difficulty-pct` and `--actual-difficulty-reason`; reviewers and testers may record reviewed difficulty "
    "with `--reviewed-difficulty-pct`, `--reviewed-difficulty-dimension`, and `--reviewed-difficulty-reason`. "
    "Valid reviewed dimensions are `implementation`, `review`, `verification`, `product_spec`, `security`, "
    "`performance`, and `coordination`. Do not guess counts or difficulty values you did not evaluate."
)

def cmd_handover(args: argparse.Namespace) -> Dict[str, Any]:
    team_slug = slugify_team_name(args.name)
    state_path = (args.state or sprintengine_state_path_for(Path.cwd(), team_slug)).resolve()
    team_dir = state_path.parent
    handover_path = handover_path_for_state(state_path)

    existing = [path for path in [state_path, handover_path] if path.exists()]
    if existing and not args.force:
        return {
            "ok": False,
            "error": "Team already has bootstrap files. Use --force only if you intend to replace the state/handover bootstrap.",
            "existing": [str(path) for path in existing],
            "write": False,
        }

    handover_text = ""
    source_metadata: Optional[Dict[str, Any]] = None
    source_bundle: List[Dict[str, Any]] = []
    captured_at = now_iso()
    if args.handover:
        source_path = args.handover.resolve()
        handover_text = source_path.read_text(encoding="utf-8")
        source_metadata = {
            "kind": "markdown",
            "origin": "file",
            "path": project_relative_display_path(state_path, handover_path),
            "originalPath": project_relative_display_path(state_path, source_path),
            "capturedAt": captured_at,
        }
    elif getattr(args, "handover_stdin", False):
        handover_text = sys.stdin.read()
        source_metadata = {
            "kind": "markdown",
            "origin": "stdin",
            "path": project_relative_display_path(state_path, handover_path),
            "capturedAt": captured_at,
        }
    elif args.handover_text:
        handover_text = args.handover_text
        source_metadata = {
            "kind": "markdown",
            "origin": "inline",
            "path": project_relative_display_path(state_path, handover_path),
            "capturedAt": captured_at,
        }

    team_dir.mkdir(parents=True, exist_ok=True)

    wrote_handover = False
    if handover_text.strip():
        handover_path.write_text(handover_text.rstrip() + "\n", encoding="utf-8")
        wrote_handover = True

    source_specs = [parse_source_bundle_arg(value) for value in getattr(args, "source", [])]
    if source_specs:
        source_dir = sources_dir_for_state(state_path)
        source_dir.mkdir(parents=True, exist_ok=True)
        used_names: set[str] = set()
        for spec in source_specs:
            original_path = Path(spec["path"]).expanduser().resolve()
            if not original_path.is_file():
                raise SystemExit(f"Source file not found: {original_path}")
            filename = safe_source_filename(original_path, used_names)
            copied_path = source_dir / filename
            copied_path.write_bytes(original_path.read_bytes())
            source_bundle.append({
                "kind": spec["kind"],
                "origin": "file",
                "path": project_relative_display_path(state_path, copied_path),
                "originalPath": project_relative_display_path(state_path, original_path),
                "capturedAt": captured_at,
            })

    initial: Dict[str, Any] = {
        "sprintengine": {
            "name": team_slug,
            "goal": args.goal or "",
            "status": "planning",
            "rosterConfigured": bool(getattr(args, "agent", None)),
        },
        "tasks": [],
        "agents": parse_agent_specs(getattr(args, "agent", None)),
        "events": [
            {
                "id": "EVT-001",
                "timestamp": now_iso(),
                "type": "handover_created",
                "actor": args.actor,
                "message": f"{args.actor} created sprintengine handover for team {team_slug}.",
            }
        ],
        "artifacts": [],
        "roles": {},
    }
    if source_metadata and handover_text.strip():
        source_metadata["planKind"] = args.source_plan_kind
        initial["source"] = source_metadata
    if source_bundle:
        initial["sourceBundle"] = source_bundle
    if wrote_handover:
        source_artifact = {
            "id": next_artifact_id(initial["artifacts"]),
            "kind": "requirements",
            "title": "Source Handoff",
            "path": project_relative_display_path(state_path, handover_path),
            "status": "approved",
            "createdBy": args.actor,
            "taskId": "",
            "fingerprint": file_fingerprint(handover_path),
            "reviewHistory": [
                {"action": "created", "actor": args.actor, "timestamp": captured_at},
                {"action": "approved", "actor": args.actor, "timestamp": captured_at, "note": "Imported as the root handoff artifact."},
            ],
            "recommendedTasks": [],
            "createdAt": captured_at,
            "updatedAt": captured_at,
            "approvedBy": args.actor,
            "approvedAt": captured_at,
        }
        initial["artifacts"].append(source_artifact)
        initial["events"].append({
            "id": "EVT-002",
            "timestamp": captured_at,
            "type": "artifact_added",
            "actor": args.actor,
            "message": f"{args.actor} registered root handoff artifact {source_artifact['id']}.",
        })
    def write_initial_state(state: Dict[str, Any]) -> Dict[str, Any]:
        state.clear()
        state.update(initial)
        return {"ok": True}

    with_locked_state(state_path, write_initial_state, initial_state={})

    init_command = f"sprintengine --state {json.dumps(str(state_path))} init"
    architect_startup_prompt = "\n\n".join([
        f"Use the existing Sprint Engine team `{team_slug}`.",
        "Fetch the canonical Sprint Engine startup instructions from the Python tool.",
        "Run:",
        f"```bash\n{init_command}\n```",
        "Then follow the returned prompt. If `handover.md` exists, treat it as incoming context, not as the final plan.",
    ])

    return {
        "ok": True,
        "action": "handover",
        "team": team_slug,
        "statePath": str(state_path),
        "handoverPath": str(handover_path) if wrote_handover else None,
        "planPath": str(plan_path_for_state(state_path)),
        "architectStartupPrompt": architect_startup_prompt,
    }

def cmd_init(args: argparse.Namespace) -> Dict[str, Any]:
    state_path = args.state
    default_name = default_swarm_name_for_state(state_path)
    initial_state: Optional[Dict[str, Any]] = None
    if not state_path.exists():
        state_path.parent.mkdir(parents=True, exist_ok=True)
        initial_state = {
            "sprintengine": {
                "name": default_name,
                "goal": getattr(args, "goal", "") or "",
                "status": "planning",
                "rosterConfigured": bool(getattr(args, "agent", None)),
            },
            "tasks": [],
            "agents": parse_agent_specs(getattr(args, "agent", None)),
            "events": [],
            "artifacts": [],
            "roles": {},
        }

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        apply_agent_specs(state, getattr(args, "agent", None))
        sprintengine = state.setdefault("sprintengine", {})
        if not sprintengine.get("name"):
            sprintengine["name"] = default_name
        if getattr(args, "goal", None) and not sprintengine.get("goal"):
            sprintengine["goal"] = args.goal
        has_product_plan_source = state_has_source_kind(state, "product_plan")
        has_architect_plan_source = state_has_source_kind(state, "architect_plan")
        existing_plan_gate = find_architect_plan_gate(state, state_path)
        if existing_plan_gate["task"] and not any(
            isinstance(task, dict) and task.get("role") == "product"
            for task in state.get("tasks", [])
        ):
            plan_gate = ensure_plan_approval_gate(state, state_path, "sprintengine", start_active=False)
            refresh_artifact_fingerprint(plan_gate["artifact"], state_path)
            recompute_phase(state)
            return {"ok": True, "planGate": plan_gate}

        roles = roster_roles(state)
        has_product_reviewer = not roster_is_configured(state) or "product" in roles
        should_create_product_gate = has_product_reviewer and (has_product_plan_source or not has_architect_plan_source)
        product_gate = (
            ensure_product_intake_gate(state, state_path, "sprintengine")
            if should_create_product_gate
            else None
        )
        product_task = product_gate["task"] if product_gate else None
        if product_task:
            add_unique_values(product_task, "implementationNotes", source_bundle_reference_notes(state))
        if has_product_plan_source and product_gate:
            seeded_product = import_source_to_team_file(state, state_path, "product_plan", "product-requirements.md")
            if seeded_product:
                product_task["title"] = "Review imported product plan"
                product_task["description"] = (
                    "Review the imported product plan against the current repository and user intent. "
                    "Update stale or incomplete details in product-requirements.md, then mark the product requirements artifact ready for user approval."
                )
                product_task["acceptanceCriteria"] = [
                    "Imported product plan is reviewed against current project context.",
                    "Stale, missing, or incorrect requirements are updated in product-requirements.md.",
                    "Product requirements artifact is marked ready for user approval after review.",
                    "Do not recreate the product plan from scratch when the imported plan is still valid.",
                ]
                product_task["implementationNotes"] = [
                    f"Imported source plan is seeded at `{product_intake_path_artifact_value(state_path)}` if that file did not already exist.",
                    "Preserve existing product-requirements.md edits on repeated init runs.",
                    *source_bundle_reference_notes(state),
                ]
            refresh_artifact_fingerprint(product_gate["artifact"], state_path)
        plan_gate = ensure_plan_approval_gate(
            state,
            state_path,
            "sprintengine",
            depends_on=str(product_task.get("id")) if product_task else None,
            start_active=False,
        )
        if has_product_plan_source and not product_gate:
            import_source_to_team_file(state, state_path, "product_plan", "product-requirements.md")
            plan_task = plan_gate["task"]
            add_unique_values(plan_task, "ownedPaths", [product_intake_path_artifact_value(state_path)])
            add_unique_values(plan_task, "implementationNotes", [
                f"Imported product plan is seeded at `{product_intake_path_artifact_value(state_path)}` if that file did not already exist.",
                "No product reviewer is rostered; review the imported product plan for stale requirements before writing the implementation plan.",
                "Preserve existing product-requirements.md edits on repeated init runs.",
            ])
        plan_task = plan_gate["task"]
        add_unique_values(plan_task, "implementationNotes", source_bundle_reference_notes(state))
        if has_architect_plan_source:
            seeded_plan = import_source_to_team_file(state, state_path, "architect_plan", "plan.md")
            plan_task = plan_gate["task"]
            if seeded_plan:
                plan_task["title"] = "Review imported implementation plan and create task graph"
                plan_task["description"] = (
                    f"Review the imported implementation plan at {plan_path_artifact_value(state_path)} against the current codebase. "
                    "Update stale or incomplete details, then create or repair task cards, dependencies, acceptance criteria, and review gates from it."
                )
                plan_task["acceptanceCriteria"] = [
                    "Imported implementation plan is reviewed against the current repository before task creation.",
                    "plan.md includes a current-codebase index mapping the affected modules, files, commands, data stores, APIs, and UI surfaces the plan relies on.",
                    "Stale, missing, or incorrect plan details are updated in plan.md.",
                    "Architect plan artifact is marked ready for user approval after review.",
                    "Implementation, validation, and required review tasks are created with Sprint Engine plan commands.",
                    "Task cards include real integration contracts and verification checks from the reviewed plan.",
                ]
                plan_task["implementationNotes"] = [
                    f"Imported source plan is seeded at `{plan_path_artifact_value(state_path)}` if that file did not already exist.",
                    "Preserve existing plan.md edits on repeated init runs.",
                    "Before creating task cards, index the current codebase areas affected by the imported plan and record that index in plan.md.",
                    "Review and update only stale or missing parts; do not rewrite valid plan content just because it was imported.",
                    *source_bundle_reference_notes(state),
                ]
            refresh_artifact_fingerprint(plan_gate["artifact"], state_path)
        recompute_phase(state)
        return {
            "ok": True,
            "team": sprintengine.get("name") or default_name,
            "productGate": product_gate,
            "planGate": plan_gate,
        }

    init_state = with_locked_state(state_path, run, initial_state=initial_state)
    plan_gate = init_state["planGate"]
    product_gate = init_state.get("productGate")
    return {
        "ok": True,
        "action": "initialized",
        "team": init_state.get("team") or default_name,
        "statePath": str(state_path),
        "productTask": product_gate["task"] if product_gate else None,
        "productArtifact": product_gate["artifact"] if product_gate else None,
        "planTask": plan_gate["task"],
        "planArtifact": plan_gate["artifact"],
    }
def runner_watch_delay_seconds(policy: Dict[str, Any], attempts: int) -> int:
    poll_interval = int(policy.get("pollIntervalSeconds") or 10)
    idle_backoff = int(policy.get("idleBackoffSeconds") or 30)
    max_backoff = int(policy.get("maxBackoffSeconds") or idle_backoff)
    if attempts <= 1:
        base_delay = poll_interval
    else:
        base_delay = idle_backoff * (2 ** max(0, attempts - 2))
    return min(max(1, base_delay), max_backoff)


def auto_mode_continuation(state: Dict[str, Any], role: str, agent_id: str) -> Optional[Dict[str, str]]:
    policy = folder_store.normalize_runner_policy(state.get("runner"))
    if policy.get("mode") != "auto":
        return None
    command = f"sprintengine join --role {role} --id {agent_id} --watch"
    return {
        "nextCommand": command,
        "nextAction": (
            "Auto Mode is on. Run the join watch command again so the Sprint Engine CLI can keep polling, "
            "resume owned rework, or claim the next gate/task for this role."
        ),
    }

def cmd_join(args: argparse.Namespace) -> Dict[str, Any]:
    import sys
    from sprintengine_core.tool.commands.task import architect_actionable_needs_input_tasks

    args.role = require_configured_role(args.role, context="Join")
    print(f"[sprintengine] reading state from: {args.state}", file=sys.stderr)

    def completion_instruction() -> str:
        if args.role in {"code_reviewer", "spec_reviewer"}:
            review_kind = "specification conformance" if args.role == "spec_reviewer" else "code quality"
            return (
                f"When complete: produce the requested {review_kind} review evidence or artifact. Work read-only: "
                "do not edit application or test code. If findings remain, record them with repeatable `--finding-json` and, when an "
                "artifact is requested, `--recommended-task`; include severity, impact, recommended fix, owner role, "
                "and verification steps. Move the task to `needs_input` only when the review output requires approval "
                "or the task is blocked from meeting acceptance. "
                f"{BENCHMARK_FEEDBACK_GUIDANCE} {DIFFICULTY_FEEDBACK_GUIDANCE} "
            )
        return (
            "When complete: if you produced findings, issues, or changes_requested, move the task back to "
            "`needs_input` so the implementer/author can address them. If you move a task to `needs_input`, "
            "classify it with `--needs-input-kind`: use `architect` for stale plans, impossible acceptance criteria, "
            "wrong paths, or architectural scope mismatches; use `user` for product decisions or approvals; use "
            "`owner` when you are waiting on your own external condition. Add `--needs-input-reason tooling` for "
            "missing commands/dependencies, or `--needs-input-reason verification` when real validation cannot be completed. "
            "Include `--needs-input-question` and, when useful, `--needs-input-suggested-resolution`. Otherwise, mark it done. "
            "If the task is too large for one agent or needs decomposition, use `needs_input` with "
            "`--needs-input-kind architect --needs-input-reason task_scope`; do not retire to signal task scope problems. "
            "After you finish your current work and should not accept more work because of context capacity, run "
            "`sprintengine roster retire --id <your-agent-id> --reason \"context capacity near limit\"`. "
            "Sprint Engine decides whether to replenish the roster; do not try to spawn your own replacement. "
            f"{BENCHMARK_FEEDBACK_GUIDANCE} {DIFFICULTY_FEEDBACK_GUIDANCE} "
        )

    def role_boundary_instruction() -> str:
        return (
            f"You are assigned role `{args.role}`. Only claim and work tasks whose Sprint Engine "
            f"`task.role` exactly matches `{args.role}`. When instructed to keep picking up ready tasks, "
            f"interpret that as ready `{args.role}` tasks only. Do not run `sprintengine task claim`, "
            f"`sprintengine task status`, `sprintengine artifact ready`, `sprintengine plan`, or similar "
            f"mutating commands for another role's task unless the user explicitly changes your assigned role. "
            f"You may inspect other roles read-only to diagnose blockers. If no task is ready for `{args.role}`, "
            f"stop and report the blocker id if one is visible."
        )

    def gate_boundary_instruction() -> str:
        if args.role == "tester":
            return (
                f"You are assigned role `{args.role}` as a quality-gate QA tester. "
                "Claim quality gates with `sprintengine task gate next`, not `sprintengine task next`. "
                "A tester gate validates another role's completed task while the task remains in its lifecycle folder. "
                "Run independent verification and, for UI or browser-visible work, use Playwright/browser MCP or equivalent browser automation when available and proportionate. "
                "You may add narrow regression tests, fixtures, or test harness wiring when that is the smallest safe way to validate the task; keep edits tightly scoped and document any companion test edits in the verdict summary or a validation_report artifact. "
                "If broader implementation changes are needed, request changes or block the gate instead of taking over the implementer's work. "
                f"{BENCHMARK_FEEDBACK_GUIDANCE} {DIFFICULTY_FEEDBACK_GUIDANCE}"
            )
        return (
            f"You are assigned role `{args.role}` as a quality-gate reviewer/tester/product reviewer. "
            "Claim quality gates with `sprintengine task gate next`, not `sprintengine task next`. "
            "A gate reviews another role's task while the task remains in its lifecycle folder; do not edit "
            "application or test code unless the user explicitly changes your assignment. "
            f"{BENCHMARK_FEEDBACK_GUIDANCE} {DIFFICULTY_FEEDBACK_GUIDANCE}"
        )

    def runner_policy(state: Dict[str, Any]) -> Dict[str, Any]:
        return folder_store.normalize_runner_policy(state.get("runner"))

    def all_tasks_done(state: Dict[str, Any]) -> bool:
        tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
        return bool(tasks) and all(task.get("status") == "done" for task in tasks)

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ensure_agent_in_roster(state, args.id, args.role, allow_retired=True)
        expired = release_expired_agent_targets(state, actor="sprintengine", excluding_agent_id=args.id)
        runtime = reconcile_agent(state, args.id, args.role)
        agent = runtime["agent"]
        if agent_is_retired(agent):
            return {
                "ok": True,
                "role": args.role,
                "agentId": args.id,
                "action": "retired",
                "runner": runner_policy(state),
                "message": "This Sprint Engine agent is retired and must not claim more work. Stop now.",
                "releasedExpired": expired["released"],
                "write": runtime["dirty"] or expired["dirty"],
            }
        active = runtime["activeTask"]
        active_gate = find_active_gate_claim(state, args.id, args.role)
        pending_gates = [
            {"task": task, "gate": gate}
            for task in state.get("tasks", []) or []
            if isinstance(task, dict)
            for gate in task_quality_gates(task)
            if gate_is_claimable_for_role(task, gate, args.role, args.id)
        ]
        ready = [t for t in state.get("tasks", []) if t.get("role") == args.role and task_is_ready(state, t)]

        prompt = load_prompt(args.role)
        policy = runner_policy(state)
        if active_gate:
            task = active_gate["task"]
            gate = active_gate["gate"]
            directive = (
                f"\n\n---\n"
                f"## Your First Action\n"
                f"You are agent `{args.id}` with role `{args.role}`.\n"
                f"You already have active gate `{gate.get('id')}` on task `{task.get('id')}`: {task.get('title') or '(untitled task)'}.\n\n"
                f"Run:\n```\nsprintengine task gate next --role {args.role} --id {args.id}\n```\n\n"
                f"This reconnects you to your existing active gate and returns the full review context.\n\n"
                f"{gate_boundary_instruction()}\n\n"
                f"{worker_execution_workspace_block(state, args.state)}\n\n"
                f"When complete, submit the gate result with `sprintengine task gate verdict`, then run "
                f"`sprintengine join --role {args.role} --id {args.id} --watch` again if Auto Mode is on; otherwise stop.\n\n"
                "**IMPORTANT: Do not edit Sprint Engine run-store files directly. "
                "All updates must go through the Sprint Engine tool.**"
            )
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "gate_resume", "task": task, "gate": gate, "runner": policy, "prompt": prompt + directive, "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

        if active:
            task_id = active.get("id")
            task_title = active.get("title") or "(untitled task)"
            directive = (
                f"\n\n---\n"
                f"## Your First Action\n"
                f"You are agent `{args.id}` with role `{args.role}`.\n"
                f"You already have active task `{task_id}`: {task_title}.\n\n"
                f"Run:\n```\nsprintengine task next --role {args.role} --id {args.id}\n```\n\n"
                f"This reconnects you to your existing active task instead of claiming a new one. "
                f"Continue the task and log evidence.\n\n"
                f"{role_boundary_instruction()}\n\n"
                f"{worker_execution_workspace_block(state, args.state)}\n\n"
                f"{artifact_registration_instruction(args.id)}\n\n"
                f"{completion_reality_instruction()}"
                f"{completion_instruction()}"
                f"If you notice a prompt or process issue that would help improve future Sprint Engine runs, include it with repeatable `--issue-json` on your final feedback command. "
                f"If your role reviews work, report concrete bugs, security issues, requirement violations, or test gaps with repeatable `--finding-json`. "
                f"After completion, run `sprintengine join --role {args.role} --id {args.id} --watch` again if Auto Mode is on; otherwise stop.\n\n"
                "**IMPORTANT: Do not edit Sprint Engine run-store files directly. "
                "All updates must go through the Sprint Engine tool.**"
            )
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "resume", "task": active, "runner": policy, "prompt": prompt + directive, "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

        if args.role == "architect" and architect_actionable_needs_input_tasks(state):
            directive = (
                f"\n\n---\n"
                f"## Your First Action\n"
                f"You are agent `{args.id}` with role `architect`.\n"
                "Architect-actionable needs_input work is queued.\n\n"
                f"Run:\n```\nsprintengine triage needs-input --id {args.id}\n```\n\n"
                "Follow the returned triage prompt. Resolve task-card, scope, artifact-review, tooling, or verification blockers through Sprint Engine commands. Do not edit application source in triage mode.\n\n"
                f"{worker_execution_workspace_block(state, args.state)}\n\n"
                "**IMPORTANT: Do not edit Sprint Engine run-store files directly. "
                "All updates must go through the Sprint Engine tool.**"
            )
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "needs_input_triage", "runner": policy, "prompt": prompt + directive, "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

        if pending_gates:
            first = pending_gates[0]
            directive = (
                f"\n\n---\n"
                f"## Your First Action\n"
                f"You are agent `{args.id}` with role `{args.role}`.\n"
                f"There are **{len(pending_gates)} quality gate(s)** ready for your role.\n\n"
                f"Run:\n```\nsprintengine task gate next --role {args.role} --id {args.id}\n```\n\n"
                "The command atomically claims one gate and returns the plan, task, evidence, comments, artifacts, and gate focus.\n\n"
                f"{gate_boundary_instruction()}\n\n"
                f"{worker_execution_workspace_block(state, args.state)}\n\n"
                f"When complete, submit the gate result with `sprintengine task gate verdict`, then run "
                f"`sprintengine join --role {args.role} --id {args.id} --watch` again if Auto Mode is on; otherwise stop.\n\n"
                "**IMPORTANT: Do not edit Sprint Engine run-store files directly. "
                "All updates must go through the Sprint Engine tool.**"
            )
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "gate_work", "readyGateCount": len(pending_gates), "task": first["task"], "gate": first["gate"], "runner": policy, "prompt": prompt + directive, "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

        if not active and not ready:
            if policy.get("stopWhenComplete") and all_tasks_done(state):
                return {"ok": True, "role": args.role, "agentId": args.id, "action": "complete", "runner": policy, "message": "All Sprint Engine tasks are done. Stop now.", "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "idle", "runner": policy, "message": f"No tasks or gates are currently ready for the '{args.role}' role.", "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

        directive = (
            f"\n\n---\n"
            f"## Your First Action\n"
            f"You are agent `{args.id}` with role `{args.role}`.\n"
            f"There are **{len(ready)} task(s)** ready for your role.\n\n"
            f"Run:\n```\nsprintengine task next --role {args.role} --id {args.id}\n```\n\n"
            f"Complete the claimed task and log evidence.\n\n"
            f"{role_boundary_instruction()}\n\n"
            f"{worker_execution_workspace_block(state, args.state)}\n\n"
            f"{artifact_registration_instruction(args.id)}\n\n"
            f"{completion_reality_instruction()}"
            f"{completion_instruction()}"
            f"If you notice a prompt or process issue that would help improve future Sprint Engine runs, include it with repeatable `--issue-json` on your final feedback command. "
            f"If your role reviews work, report concrete bugs, security issues, requirement violations, or test gaps with repeatable `--finding-json`. "
            f"After completion, run `sprintengine join --role {args.role} --id {args.id} --watch` again if Auto Mode is on; otherwise stop.\n\n"
            "**IMPORTANT: Do not edit Sprint Engine run-store files directly. "
            "All updates must go through the Sprint Engine tool.**"
        )
        return {"ok": True, "role": args.role, "agentId": args.id, "action": "work", "readyTaskCount": len(ready), "runner": policy, "prompt": prompt + directive, "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

    if not getattr(args, "watch", False):
        return with_locked_state(args.state, run)

    started_at = time.monotonic()
    attempts = 0
    delay_seconds = 0
    max_wait_seconds = getattr(args, "max_wait_seconds", None)
    while True:
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        attempts += 1
        result = with_locked_state(args.state, run)
        result["watch"] = {"attempts": attempts}
        action = result.get("action")
        policy = folder_store.normalize_runner_policy(result.get("runner"))
        if action not in {"idle"}:
            return result
        if policy.get("mode") != "auto":
            result["message"] = f"{result.get('message', 'No work is ready')} Auto Mode is off; stop now."
            return result
        elapsed = time.monotonic() - started_at
        if max_wait_seconds is not None and elapsed >= float(max_wait_seconds):
            result["message"] = f"{result.get('message', 'No work is ready')} Auto Mode is on; max wait elapsed."
            return result
        delay_seconds = runner_watch_delay_seconds(policy, attempts)
        if max_wait_seconds is not None:
            remaining = max(0.0, float(max_wait_seconds) - elapsed)
            delay_seconds = min(delay_seconds, int(remaining) if remaining >= 1 else 1)

def cmd_merge_start(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_mutation_state(args.state)
    target = args.target.strip()
    if not target:
        raise SystemExit("--target is required.")
    return {
        "ok": True,
        "role": "architect",
        "action": "merge_start",
        "id": args.id,
        "target": target,
        "prompt": build_merge_start_prompt(state, args.state, args.id, target),
    }


def build_recovery_prompt(state: Dict[str, Any], state_path: Path, backup_path: Path) -> str:
    sprintengine = state.get("sprintengine", {})
    goal = sprintengine.get("goal") or "(not set - read the codebase for context)"
    tasks = state.get("tasks", [])
    task_count = len(tasks)
    return "\n".join([
        "You are the recovery architect for this sprintengine.",
        f"Goal: {goal}",
        f"Run store: {state_path.parent}",
        f"Existing task count: {task_count}",
        "",
        "Keep this deliberately simple. This is an integrity recovery pass, not implementation work.",
        "Your job is to compare the existing tasks against the current codebase and product goal, update truthful task status/evidence, and repair task/acceptance defects that would let fake product behavior count as done.",
        "",
        "Hard rules:",
        "- Do NOT run `sprintengine init`.",
        "- Do NOT rewrite the whole plan or start implementation.",
        "- Do NOT delete existing tasks unless the user explicitly requested board surgery.",
        "- You MAY use `Sprint Engine plan update-task`, `Sprint Engine plan add-task`, `Sprint Engine plan add-dependency`, or `Sprint Engine plan remove-dependency` only to repair completion gates, add missing real-integration/verification tasks, or make dependencies block fake completion.",
        "- If a plan/task claims product completion through sample data, fake responses, mocked transports, stubbed commands, placeholder persistence, disconnected UI state, or documentation-only verification, correct the task graph or mark the affected task `needs_input` with a blocker.",
        "- Do NOT create a new plan file.",
        "- Do NOT inspect a different `plan.md` from another Sprint Engine team folder.",
        "- Do NOT clear the board because tasks look stale.",
        "- Preserve task IDs where possible. Prefer updating descriptions, acceptance criteria, dependencies, notes, and status over broad replacement.",
        "- Only add tasks when the current graph has no task that can verify or implement the real product integration.",
        "",
        "Work through every existing task in the folder store in order.",
        "",
        "For each task:",
        "1. Read the task title, description, owned paths, acceptance criteria, notes, and existing evidence.",
        "2. Inspect the current codebase for the relevant implementation.",
        "3. Decide the real status: todo, in_progress, needs_input, or done. A task is not done if it only works with mocks, samples, stubs, fake responses, placeholder persistence, disconnected UI state, or unverified hardware/external integrations.",
        "4. Update only that task's status.",
        "5. If marking done or in_progress, append evidence with files checked, commands run, and a short result.",
        "6. If uncertain, mark needs_input or add a note. Do not guess.",
        "",
        "Use command discovery before your first mutation:",
        "- `sprintengine --help`",
        "- `sprintengine task status --help`",
        "- `sprintengine task log --help`",
        "- `sprintengine task note --help`",
        "",
        "Allowed write commands are:",
        "- `sprintengine task status`",
        "- `sprintengine task log`",
        "- `sprintengine task note`",
        "- `Sprint Engine plan update-task` for tightening descriptions, paths, and acceptance criteria",
        "- `Sprint Engine plan add-task` for missing real-integration or verification gates",
        "- `Sprint Engine plan add-dependency` and `Sprint Engine plan remove-dependency` for dependency corrections",
        "",
        "If a needed command is unavailable or fails, stop and explain the blocker instead of editing Sprint Engine files directly.",
    ])

def cmd_recover(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_mutation_state(args.state)
    prompt = build_recovery_prompt(state, args.state, args.state.parent)
    return {
        "ok": True,
        "role": "architect",
        "action": "recover",
        "taskCount": len(state.get("tasks", [])),
        "prompt": prompt,
    }

def cmd_summary(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": True, "summary": build_run_summary(state), "write": False}
    return with_locked_state(args.state, run)

def cmd_projection(args: argparse.Namespace) -> Dict[str, Any]:
    try:
        return folder_store.build_projection(args.state.parent, state_path=args.state)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

def cmd_runner_status(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": True, "runner": folder_store.normalize_runner_policy(state.get("runner")), "write": False}

    return with_locked_state(args.state, run)

def cmd_runner_set(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        current = folder_store.normalize_runner_policy(state.get("runner"))
        if args.mode:
            current["mode"] = args.mode
        if args.poll_interval_seconds is not None:
            current["pollIntervalSeconds"] = args.poll_interval_seconds
        if args.idle_backoff_seconds is not None:
            current["idleBackoffSeconds"] = args.idle_backoff_seconds
        if args.max_backoff_seconds is not None:
            current["maxBackoffSeconds"] = args.max_backoff_seconds
        if args.stop_when_complete is not None:
            current["stopWhenComplete"] = bool(args.stop_when_complete)
        state["runner"] = folder_store.normalize_runner_policy(current)
        event = append_event(state, "runner_policy_updated", args.actor, f"{args.actor} set runner mode to {state['runner']['mode']}.")
        return {"ok": True, "runner": state["runner"], "event": event}

    return with_locked_state(args.state, run)


def cmd_triage_needs_input(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        from sprintengine_core.tool.commands.task import architect_actionable_needs_input_tasks, normalized_needs_input_for_routing

        ensure_agent_in_roster(state, args.id, "architect")
        tasks = architect_actionable_needs_input_tasks(state)
        prompt_lines = [
            "You are the Sprint Engine architect triaging architect-actionable needs_input tasks.",
            "",
            "Goal:",
            str(state.get("sprintengine", {}).get("goal") or state.get("goal") or ""),
            "",
            "Rules:",
            "- Inspect the blocked task card, notes, evidence, owned paths, and current code before changing the plan.",
            "- `needsInput.kind` routes who acts: architect, user, or owner. Use `reason` for artifact, tooling, verification, product, and task-scope classification.",
            "- Resolve planning defects by updating task cards or adding follow-up tasks; do not edit application source in this triage mode.",
            "- For reason=artifact_review, read the referenced artifact, adjudicate recommended follow-up tasks, wire blockers before validation when needed, then approve/request changes or resolve the blocked task.",
            "- Use `sprintengine plan update-task --force` for active task-card corrections.",
            "- Use `sprintengine plan add-task`, `sprintengine plan add-dependency`, or `sprintengine plan remove-dependency` only when the task graph really needs repair.",
            "- When the original owner should continue, use `sprintengine task resolve-input --task-id <id> --id architect --resolution \"...\"` instead of plain `task status --status in_progress` so the owner receives a resume notification.",
            "- When architect adjudication completes a review-only blocked task, use `sprintengine task resolve-input --task-id <id> --id architect --resolution \"...\" --complete`.",
            "- If the original owner is inactive or should not continue, use `sprintengine task release --task-id <id> --id architect --reason \"...\"`.",
            "- Leave human-owned decisions as `needs_input` with kind=user; do not guess product intent.",
            "- When the worker can continue, say so clearly in the note. The original worker still owns implementation and completion evidence.",
            "",
        ]
        if not tasks:
            prompt_lines.extend([
                "No architect-actionable needs_input tasks are currently queued.",
                "Stop now.",
            ])
            return {"ok": True, "tasks": [], "prompt": "\n".join(prompt_lines), "write": False}

        prompt_lines.append("Architect-actionable blockers:")
        for task in tasks:
            needs_input = normalized_needs_input_for_routing(task.get("needsInput"))
            evidence = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
            task_artifacts = artifacts_for_task(state, task.get("id"))
            artifact_lines = []
            for artifact in task_artifacts:
                artifact_lines.append(
                    f"{artifact.get('id')} {artifact.get('kind')} status={artifact.get('status')} "
                    f"path={artifact.get('path') or '(none)'} recommendedTasks={len(artifact.get('recommendedTasks') or [])}"
                )
            prompt_lines.extend([
                "",
                f"- Task: {task.get('id')} - {task.get('title')}",
                f"  Role/owner: {task.get('role')} / {task.get('ownerAgentId') or 'unowned'}",
                f"  Route/reason: {needs_input.get('kind') or '(none)'} / {needs_input.get('reason') or '(unspecified)'}",
                f"  Artifact id: {needs_input.get('artifactId') or '(not provided)'}",
                f"  Question: {needs_input.get('question') or '(not provided)'}",
                f"  Suggested resolution: {needs_input.get('suggestedResolution') or '(not provided)'}",
                f"  Artifacts: {' | '.join(artifact_lines) or '(none)'}",
                f"  Description: {task.get('description') or ''}",
                f"  Owned paths: {', '.join(task.get('ownedPaths') or []) or '(none)'}",
                f"  Acceptance: {' | '.join(task.get('acceptanceCriteria') or []) or '(none)'}",
                f"  Notes: {' | '.join(task.get('notes') or []) or '(none)'}",
                f"  Evidence summary: {evidence.get('summary') or '(none)'}",
            ])

        return {
            "ok": True,
            "tasks": [
                {
                    "id": task.get("id"),
                    "title": task.get("title"),
                    "role": task.get("role"),
                    "ownerAgentId": task.get("ownerAgentId"),
                    "needsInput": normalized_needs_input_for_routing(task.get("needsInput")),
                    "artifacts": [
                        {
                            "id": artifact.get("id"),
                            "kind": artifact.get("kind"),
                            "status": artifact.get("status"),
                            "path": artifact.get("path"),
                            "recommendedTaskCount": len(artifact.get("recommendedTasks") or []),
                        }
                        for artifact in artifacts_for_task(state, task.get("id"))
                    ],
                }
                for task in tasks
            ],
            "prompt": "\n".join(prompt_lines),
            "write": False,
        }

    return with_locked_state(args.state, run)

handover = cmd_handover
init = cmd_init
join = cmd_join
merge_start = cmd_merge_start
recover = cmd_recover
summary = cmd_summary
projection = cmd_projection
runner_status = cmd_runner_status
runner_set = cmd_runner_set
triage_needs_input = cmd_triage_needs_input
