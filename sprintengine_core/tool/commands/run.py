"""Sprint Engine run command handlers."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.tool.artifacts import artifacts_for_task, file_fingerprint, next_artifact_id, project_relative_display_path
from sprintengine_core.tool.constants import VALID_TASK_PHASES
from sprintengine_core.tool.paths import now_iso, sprintengine_state_path_for
from sprintengine_core.tool.plans import (
    build_run_summary,
    default_swarm_name_for_state,
    ensure_plan_approval_gate,
    ensure_product_intake_gate,
    find_architect_plan_gate,
    apply_source_context_to_task,
    EPIC_CHILD_KEY,
    EPIC_CHILD_SOURCE_LABEL,
    epic_child_source_paths,
    handover_path_for_state,
    import_source_to_team_file,
    parse_source_bundle_arg,
    resolve_planning_role,
    plan_path_artifact_value,
    plan_path_for_state,
    product_intake_path_artifact_value,
    reference_source_display_path,
    refresh_artifact_fingerprint,
    safe_source_filename,
    slugify_team_name,
    source_bundle_reference_notes,
    source_kind_is_reference,
    source_plan_kind,
    sources_dir_for_state,
    state_has_source_kind,
)
from sprintengine_core.skill_layers import run_is_backlog_sourced
from sprintengine_core.tool.prompts import artifact_registration_instruction, completion_reality_instruction, load_prompt
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.phase_prompts import worker_execution_workspace_block
from sprintengine_core.tool.repo_model import get_run_vcs, parse_repo_declarations
from sprintengine_core.tool.shell import ensure_run_worktree
from sprintengine_core.tool.state import (
    append_event,
    append_task_activity,
    apply_configured_roles,
    apply_init_source,
    apply_role_runtimes,
    apply_default_phases,
    configured_role_set,
    declared_repo_ids,
    end_lease,
    ensure_role_in_roster,
    find_task,
    load_mutation_state,
    reconcile_worker,
    refuse_if_run_canceled,
    release_expired_agent_targets,
    roster_is_configured,
    run_is_canceled,
    with_locked_state,
)
from sprintengine_core.tool.tasks import (
    add_unique_values,
    ensure_evidence,
    recompute_phase,
    refresh_task_diff_evidence,
    task_is_ready,
)

EVIDENCE_STYLE_GUIDANCE = (
    "Keep evidence, comments, and log summaries succinct and machine-first: outcome first, "
    "structured fields over prose, one fact per entry, under 700 characters per prose field. "
)

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
    "`--difficulty-pct` and `--difficulty-reason`; implementers report actual difficulty at publish time with "
    "`--actual-difficulty-pct` and `--actual-difficulty-reason`. "
    "Do not guess counts or difficulty values you did not evaluate."
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

    reference_mode = bool(getattr(args, "reference", False))
    handover_text = ""
    source_metadata: Optional[Dict[str, Any]] = None
    source_bundle: List[Dict[str, Any]] = []
    captured_at = now_iso()
    if reference_mode and args.handover:
        # Reference mode: record the markdown source as a project-root-relative
        # reference to the canonical original. Do not read it into handover_text
        # (so handover.md is never written) and do not copy it — the architect
        # reads and updates the original file in place.
        source_path = args.handover.resolve()
        if not source_path.is_file():
            raise SystemExit(f"Source file not found: {source_path}")
        source_metadata = {
            "kind": "markdown",
            "origin": "reference",
            "path": project_relative_display_path(state_path, source_path),
            "capturedAt": captured_at,
        }
    elif args.handover:
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
    # On an epic handover the bundle IS the epic's children — that is what the
    # flag combination has always meant (the epic is the root source, the
    # children are the sources). Marking them here is what lets the planner
    # enumerate them one-to-one and the coverage warning count them, on the
    # CLI/mobile launch path exactly as on the desktop one (backlog item 2018).
    bundle_is_epic_children = str(getattr(args, "source_plan_kind", "") or "").strip() == "epic"
    if source_specs:
        source_dir: Optional[Path] = None
        used_names: set[str] = set()
        if not reference_mode:
            source_dir = sources_dir_for_state(state_path)
            source_dir.mkdir(parents=True, exist_ok=True)
        for spec in source_specs:
            original_path = Path(spec["path"]).expanduser().resolve()
            if not original_path.is_file():
                raise SystemExit(f"Source file not found: {original_path}")
            if reference_mode:
                # Record a project-root-relative reference; the original stays
                # canonical and is read/updated in place.
                source_bundle.append({
                    "kind": spec["kind"],
                    "origin": "reference",
                    "path": project_relative_display_path(state_path, original_path),
                    "capturedAt": captured_at,
                    **({EPIC_CHILD_KEY: True} if bundle_is_epic_children else {}),
                })
            else:
                assert source_dir is not None
                filename = safe_source_filename(original_path, used_names)
                copied_path = source_dir / filename
                copied_path.write_bytes(original_path.read_bytes())
                source_bundle.append({
                    "kind": spec["kind"],
                    "origin": "file",
                    "path": project_relative_display_path(state_path, copied_path),
                    "originalPath": project_relative_display_path(state_path, original_path),
                    "capturedAt": captured_at,
                    **({EPIC_CHILD_KEY: True} if bundle_is_epic_children else {}),
                })

    initial: Dict[str, Any] = {
        "sprintengine": {
            "name": team_slug,
            "goal": args.goal or "",
            "status": "planning",
            "rosterConfigured": bool(getattr(args, "agent", None)),
        },
        "tasks": [],
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
    root_is_reference = bool(source_metadata and source_metadata.get("origin") == "reference")
    if source_metadata and (handover_text.strip() or root_is_reference):
        source_metadata["planKind"] = args.source_plan_kind
        initial["source"] = source_metadata
    if source_bundle:
        initial["sourceBundle"] = source_bundle
    # Register the root handoff artifact for a written copy or an in-place
    # reference. References point the approved artifact at the canonical original
    # and carry no fingerprint (there is no snapshot to drift from).
    if wrote_handover or root_is_reference:
        if root_is_reference:
            root_artifact_path = source_metadata["path"]
            root_artifact_fingerprint = None
            root_artifact_note = "Referenced in place as the root handoff source (not copied into the run store)."
        else:
            root_artifact_path = project_relative_display_path(state_path, handover_path)
            root_artifact_fingerprint = file_fingerprint(handover_path)
            root_artifact_note = "Imported as the root handoff artifact."
        source_artifact = {
            "id": next_artifact_id(initial["artifacts"]),
            "kind": "requirements",
            "title": "Source Handoff",
            "path": root_artifact_path,
            "status": "approved",
            "createdBy": args.actor,
            "taskId": "",
            "fingerprint": root_artifact_fingerprint,
            "reviewHistory": [
                {"action": "created", "actor": args.actor, "timestamp": captured_at},
                {"action": "approved", "actor": args.actor, "timestamp": captured_at, "note": root_artifact_note},
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
    # The projects this run spans, fixed here at creation and immutable after — the
    # same posture as the worktree toggle, and for the same reason: every task, lock,
    # commit, and worktree is resolved through this list for the life of the run.
    declared_repos = parse_repo_declarations(getattr(args, "repo", None) or [])
    if declared_repos and not getattr(args, "use_worktrees", False):
        raise SystemExit(
            "A sprint can only span more than one project when each project gets its own run worktree. "
            "Add --use-worktrees true, or drop --repo."
        )
    if getattr(args, "base_start_point", None) and not getattr(args, "use_worktrees", False):
        # The start point only names where the run branch and worktree begin, so it
        # is meaningless without worktrees. Its help text already says it requires
        # --use-worktrees; silently ignoring it (the old behavior) let a caller
        # believe a custom start point took effect. Refuse, as --repo does.
        raise SystemExit(
            "--base-start-point only applies when the sprint uses worktrees. "
            "Add --use-worktrees true, or drop --base-start-point."
        )
    requested_name = (getattr(args, "name", None) or "").strip()
    default_name = requested_name or default_swarm_name_for_state(state_path)
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
            "events": [],
            "artifacts": [],
            "roles": {},
        }

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        # `--agent role:id` no longer seeds an agents map (MC-1591: leases replace
        # the roster); it only marks the run as roster-configured. Role authority
        # is `configuredRoles`, applied below.
        if getattr(args, "agent", None):
            state.setdefault("sprintengine", {})["rosterConfigured"] = True
        apply_role_runtimes(state, getattr(args, "role_runtimes_json", None))
        apply_configured_roles(state, getattr(args, "configured_roles_json", None))
        # The run's phase list, from the wizard's "Agents review their own work"
        # toggle. Default AND ceiling for every task (assert_phases_within_run_ceiling).
        apply_default_phases(state, getattr(args, "default_phases_json", None))
        # Seed the sprint source at creation (app-created runs) so run.yaml carries
        # the "Started from" seed before any agent runs handover. write_run persists
        # state[source]/[sourceBundle] via RUN_SOURCE_KEYS.
        apply_init_source(
            state,
            getattr(args, "source_json", None),
            getattr(args, "source_bundle_json", None),
        )
        sprintengine = state.setdefault("sprintengine", {})
        if not sprintengine.get("name"):
            sprintengine["name"] = default_name
        if getattr(args, "goal", None) and not sprintengine.get("goal"):
            sprintengine["goal"] = args.goal
        # When worktree mode is requested, create (or reuse) one shared run
        # worktree + branch for the whole team before any task work. The vcs
        # block is recorded into run state so every agent prompt routes work
        # into the same worktree and per-task commits land on the same branch.
        if getattr(args, "use_worktrees", False) and not get_run_vcs(state):
            ensure_run_worktree(
                state,
                state_path,
                repos=declared_repos,
                start_point=getattr(args, "base_start_point", None),
            )
        elif declared_repos and get_run_vcs(state):
            # A second init cannot grow the run's project set: repos are fixed at
            # creation and the worktrees, locks, and branches are already built
            # around the declared list. The old code silently dropped these new
            # entries once a vcs block existed. Refuse when they name a project the
            # run does not already declare; a re-declaration of the same projects is
            # an idempotent no-op and still succeeds.
            existing_ids = set(declared_repo_ids(state))
            undeclared = [repo["id"] for repo in declared_repos if repo["id"] not in existing_ids]
            if undeclared:
                raise SystemExit(
                    "This sprint's projects are fixed at creation and its worktrees already exist. "
                    f"Cannot add {', '.join(undeclared)} now. Re-run without --repo, or create a new sprint."
                )
        has_product_plan_source = state_has_source_kind(state, "product_plan")
        has_architect_plan_source = state_has_source_kind(state, "architect_plan")
        # An epic root source (reference-based backlog epic launch) is a plan
        # source: the architect reviews the epic + its child design docs in place
        # and builds the task graph. It is `epic` only as the root planKind — its
        # children carry their own leaf kinds in the source bundle.
        has_epic_source = source_plan_kind(state) == "epic"
        existing_plan_gate = find_architect_plan_gate(state, state_path)
        if existing_plan_gate["task"] and not any(
            isinstance(task, dict) and task.get("role") == "product"
            for task in state.get("tasks", [])
        ):
            plan_gate = ensure_plan_approval_gate(state, state_path, "sprintengine", start_active=False)
            refresh_artifact_fingerprint(plan_gate["artifact"], state_path)
            recompute_phase(state)
            return {"ok": True, "planGate": plan_gate}

        # The run's ENABLED roles (configuredRoles) decide this, not any seated
        # worker: init runs before any worker has claimed, and a product gate opened
        # for a run whose configuredRoles has no `product` is a task no worker may
        # ever claim — and the plan gate dependsOn it, so the whole run is dead on
        # arrival. A run with no configuredRoles falls back to its `--agent` specs:
        # a headless `--agent product:id` still stipulates a product reviewer, and
        # leases dropped the agents map, so the roles are read straight off the CLI
        # specs (never a seated record). With no specs at all, an unconfigured run
        # opens the gate; a configured legacy run without a product reviewer does not.
        configured = configured_role_set(state)
        if configured is not None:
            has_product_reviewer = "product" in configured
        else:
            seeded_roles = {
                str(spec).split(":", 1)[0].strip()
                for spec in (getattr(args, "agent", None) or [])
            }
            has_product_reviewer = (
                "product" in seeded_roles if seeded_roles else not roster_is_configured(state)
            )
        # An epic source only opens a product intake gate when a child is itself a
        # product plan; otherwise the architect plans directly from the epic's
        # design docs. Non-epic behavior is unchanged.
        should_create_product_gate = has_product_reviewer and (
            has_product_plan_source
            or (not has_architect_plan_source and not has_epic_source)
        )
        product_gate = (
            ensure_product_intake_gate(state, state_path, "sprintengine")
            if should_create_product_gate
            else None
        )
        product_task = product_gate["task"] if product_gate else None
        if product_task:
            add_unique_values(product_task, "implementationNotes", source_bundle_reference_notes(state, state_path))
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
                    *source_bundle_reference_notes(state, state_path),
                ]
                apply_source_context_to_task(product_task, state, state_path)
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
        add_unique_values(plan_task, "implementationNotes", source_bundle_reference_notes(state, state_path))
        if has_architect_plan_source and source_kind_is_reference(state, "architect_plan"):
            # Reference-sourced implementation plan (a backlog item launched in
            # place): the referenced file is the canonical plan. plan.md is NOT
            # seeded — the architect updates the source file itself and writes
            # plan.md as a thin manifest, mirroring the epic launch path.
            plan_task = plan_gate["task"]
            reference_path = reference_source_display_path(state, "architect_plan")
            plan_task["title"] = "Review referenced plan in place and create task graph"
            plan_task["description"] = (
                f"Review the referenced implementation plan `{reference_path}` against the current codebase. "
                "Update stale or incomplete plan content in that file itself, then write "
                f"{plan_path_artifact_value(state_path)} as a manifest that references it "
                "(project-root-relative), and create the full task graph."
            )
            plan_task["acceptanceCriteria"] = [
                f"The referenced plan `{reference_path}` is read and verified against the current repository before task creation.",
                "Stale, missing, or incorrect plan content is updated in the referenced plan file itself, not re-authored into plan.md.",
                "plan.md is a manifest: it references the source plan by project-root-relative path with a verification note, and adds only the current-codebase index, cross-cutting decisions, risks, roster adaptations, and the task graph summary.",
                "Architect plan artifact is marked ready for user approval after review.",
                "Implementation, validation, and required review tasks are created with Sprint Engine plan commands.",
                "Task cards include real integration contracts and verification checks from the reviewed plan.",
                f"Every task derived from the referenced plan carries `{reference_path}` in its sourceDocs (--source-doc), and the plan's acceptance criteria are collectively covered by task acceptance criteria.",
            ]
            plan_task["implementationNotes"] = [
                "In worktree-mode runs, edit the copy of the referenced plan in its own project's worktree so updates ride that project's run branch and pull request.",
                "Do not copy valid plan prose into plan.md; the manifest references the plan and records verification, the codebase index, decisions, risks, and the task graph summary.",
                "Run-scoped material (codebase index, roster adaptation, task graph summary) belongs in the plan.md manifest, not in the referenced plan file.",
                "Set --source-doc to the referenced plan on every task derived from it: the plan is the worker's canonical brief, injected into the claim prompt as read-in-full context. Keep the task card the delta — verified/corrected pointers, pinned decisions, cross-task contracts, and role scope — never a restatement.",
                *source_bundle_reference_notes(state, state_path),
            ]
            apply_source_context_to_task(plan_task, state, state_path)
            refresh_artifact_fingerprint(plan_gate["artifact"], state_path)
        elif has_architect_plan_source:
            seeded_plan = import_source_to_team_file(state, state_path, "architect_plan", "plan.md")
            plan_task = plan_gate["task"]
            if seeded_plan:
                plan_task["title"] = "Review imported implementation plan and create task graph"
                plan_task["description"] = (
                    f"Review the imported implementation plan at {plan_path_artifact_value(state_path)} against the current codebase. "
                    "Update stale or incomplete details, then create or repair task cards, dependencies, and acceptance criteria from it."
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
                    *source_bundle_reference_notes(state, state_path),
                ]
                apply_source_context_to_task(plan_task, state, state_path)
            refresh_artifact_fingerprint(plan_gate["artifact"], state_path)
        elif has_epic_source:
            # Reference-based epic launch: the epic and its child items are the
            # canonical plan. plan.md is NOT seeded — it becomes a thin manifest
            # that references those documents. The planning role reviews and
            # updates the design docs in place, then SEQUENCES the children into a
            # task graph rather than re-authoring them as fresh task cards
            # (backlog item 2018): one task per child, the item stays the spec.
            plan_task = plan_gate["task"]
            plan_task["title"] = "Sequence the epic's child items into a task graph"
            plan_task["description"] = (
                "Every open child item of the epic is one task. Review the referenced epic and every child "
                "item against the current codebase, update stale or incomplete design content in those "
                f"backlog files themselves, then write {plan_path_artifact_value(state_path)} as a manifest "
                "that references each source document (project-root-relative), and mint exactly one task per "
                "child item. Spend your planning effort on the graph — ordering, concurrency, dependencies — "
                "not on rewriting content the item already carries."
            )
            plan_task["acceptanceCriteria"] = [
                "Every open child item of the epic is enumerated (children are the backlog items whose `epic:` frontmatter names the epic slug) and each is read in full.",
                "Exactly one task is minted per open child item: no child is split across tasks, and no task covers two children.",
                "Every minted task carries its child item as its backlogRef (--backlog-ref) and as its sourceDocs entry (--source-doc), and takes its title from the item.",
                "Minted tasks carry no description and no acceptance criteria: the item is the spec, and the card is the execution record.",
                "Every minted task declares the modules it works in (--path, directory paths); no minted task declares a file path.",
                "Tasks whose modules overlap carry an ordering edge between them; tasks with disjoint modules carry none, so they run concurrently.",
                "An item's `dependsOn` frontmatter is reproduced as a dependency edge between the tasks minted for those items.",
                "Each child item is verified against the current codebase; stale, missing, or incorrect design content is updated in the backlog files themselves, not re-authored into plan.md.",
                "plan.md is a manifest: it references every source document by project-root-relative path with a per-document verification note, and adds only cross-cutting decisions, risks, and the task graph summary.",
                "The plan artifact is marked ready for user approval after review.",
            ]
            plan_task["implementationNotes"] = [
                # Only when the launch actually marked children. A run store
                # seeded before the marker existed has an unlabelled bundle, and
                # pointing at a list that is not there would read as "there are
                # no children" — the live grep below is what carries those runs.
                *([
                    f"This task's incoming source context lists every seeded child item as `{EPIC_CHILD_SOURCE_LABEL}`; mint exactly one task per entry so labelled. Entries with any other label are reading material, not work."
                ] if epic_child_source_paths(state) else []),
                "Re-check live membership before you finish — nothing about the epic is frozen at launch: `grep -l \"^epic: <slug>$\" backlog/*.md`, where <slug> is the epic file stem. A child added since launch is minted like any other.",
                "Take each task's title from its item. Leave the description and acceptance criteria empty: --source-doc injects the item into the worker's claim prompt as read-in-full context, so restating it in the card only creates a second version to drift.",
                "Cross-task contracts, decisions, and risks belong in the plan.md manifest, not in the minted cards.",
                "Infer each task's modules from its item — package or directory level, never a file. A loose, honest guess is the target; this does not need to be precise.",
                "Serialize tasks whose modules overlap with a dependency edge. A task's commit sweeps everything dirty inside its modules, so two tasks sharing one never run at the same time; the edge records the order you intend instead of leaving the engine to pick one.",
                "In worktree-mode runs, edit the copies of the backlog files in their own project's worktree so design updates ride that project's run branch and pull request.",
                "Do not copy valid design prose into plan.md; the manifest only references the design documents and records verification, decisions, risks, and the task graph summary.",
                "Additional relevant documents (design systems, mockups, Knowledge Graph notes) may be added to the manifest as project-root-relative references.",
                # No child-status note. Child item status is app-owned and propagates
                # one way, from the run: `in_progress` when a child's OWN task claims,
                # `completed` only once the sprint has LANDED (MC-2017,
                # resolveSprintEngineChildRunLink). This branch used to tell the
                # planner to mint a task that writes `status: completed` when the
                # sprint COMPLETES, which is a second writer racing the first and
                # wrong on both timing and reversibility: it stamps `completed` onto
                # a branch that has not merged, and once an item reads `completed`
                # neither the landing pass nor the cancel restore will touch it again.
                *source_bundle_reference_notes(state, state_path),
            ]
            apply_source_context_to_task(plan_task, state, state_path)
            refresh_artifact_fingerprint(plan_gate["artifact"], state_path)
        recompute_phase(state)
        return {
            "ok": True,
            "team": sprintengine.get("name") or default_name,
            "productGate": product_gate,
            "planGate": plan_gate,
            "vcs": get_run_vcs(state),
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
        "vcs": init_state.get("vcs"),
    }
def cmd_join(args: argparse.Namespace) -> Dict[str, Any]:
    """One-shot routing + role prompt for a human or debug CLI operator.

    Autonomous agents never come through here: the managed runtime dispatches them
    with `sprintengine.agent.join` and they claim with `sprintengine.task.next`.
    This reports what the run would hand this role right now and returns once —
    the polling watch loop and its completion machinery were retired with the
    CLI-runner era (MC-1827).
    """
    import sys
    from sprintengine_core.tool.commands.task import planner_actionable_needs_input_tasks

    args.role = require_configured_role(args.role, context="Join")
    print(f"[sprintengine] reading state from: {args.state}", file=sys.stderr)

    def completion_instruction() -> str:
        return (
            "When your implementation is complete, publish it with `sprintengine task publish`. The engine detects "
            "whether you produced a diff: if you did, the task enters its review phase and the publish response carries "
            "your review directive; if you did not, the task lands directly in `done`. You own the task through every "
            "phase — fix what you find, then close each phase with `sprintengine task advance`. "
            "If you move a task to `needs_input`, "
            "classify it with `--needs-input-kind`: use `architect` for stale plans, impossible acceptance criteria, "
            "wrong paths, or architectural scope mismatches; use `user` for product decisions, approvals, real hardware, "
            "credentials, or another outside check. Add `--needs-input-reason tooling` for "
            "missing commands/dependencies, or `--needs-input-reason verification` when real validation cannot be completed. "
            "Include `--needs-input-question` and, when useful, `--needs-input-suggested-resolution`. "
            "If the task is too large for one agent or needs decomposition, use `needs_input` with "
            "`--needs-input-kind architect --needs-input-reason task_scope`. "
            "After you finish your current work, if you are near context capacity and should not accept more, "
            "stop — do not claim another task. Sprint Engine reclaims your task lease and spawns a replacement "
            "worker on demand; do not try to spawn your own replacement. "
            f"{EVIDENCE_STYLE_GUIDANCE}"
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

    def runner_policy(state: Dict[str, Any]) -> Dict[str, Any]:
        return folder_store.normalize_runner_policy(state.get("runner"))

    def all_tasks_done(state: Dict[str, Any]) -> bool:
        # Done-or-canceled, matching recompute_phase's rollup exactly. A strict
        # every-done here while the rollup tolerates canceled would report "no work
        # ready" on a run the board already calls completed — one canceled task
        # would make the run look permanently stalled to an operator.
        tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
        return bool(tasks) and all(task.get("status") in {"done", "canceled"} for task in tasks)

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        # A canceled run is terminal: report it as canceled rather than letting
        # "No tasks are currently ready" read as a transient idle. Reported before
        # roster/lease reconciliation so a canceled run does no dispatch bookkeeping.
        if run_is_canceled(state):
            return {
                "ok": True,
                "role": args.role,
                "agentId": args.id,
                "action": "canceled",
                "runner": runner_policy(state),
                "message": "This Sprint Engine run was canceled. Stop; no work will be dispatched.",
                "write": False,
            }
        ensure_role_in_roster(state, args.role)
        expired = release_expired_agent_targets(state, actor="sprintengine", excluding_agent_id=args.id)
        runtime = reconcile_worker(state, args.id, args.role)
        active = runtime["activeTask"]
        ready = [t for t in state.get("tasks", []) if t.get("role") == args.role and task_is_ready(state, t)]

        prompt = load_prompt(
            args.role,
            backlog_sourced=run_is_backlog_sourced(state),
            staffed_roles=[str(entry) for entry in (state.get("configuredRoles") or []) if str(entry).strip()],
        )
        policy = runner_policy(state)

        if active:
            task_id = active.get("id")
            task_title = active.get("title") or "(untitled task)"
            if active.get("status") == "needs_input":
                needs_input = active.get("needsInput") if isinstance(active.get("needsInput"), dict) else {}
                question = str(needs_input.get("question") or "").strip()
                route = str(needs_input.get("kind") or "input").strip()
                message = (
                    f"Task {task_id} is in needs_input"
                    f"{f' ({route})' if route else ''}. "
                    "Stop until the blocker is resolved."
                )
                if question:
                    message = f"{message} Question: {question}"
                return {
                    "ok": True,
                    "role": args.role,
                    "agentId": args.id,
                    "action": "blocked",
                    "task": active,
                    "runner": policy,
                    "message": message,
                    "blocker": {
                        "reason": "needs_input",
                        "kind": route,
                        "question": question,
                    },
                    "releasedExpired": expired["released"],
                    "write": runtime["dirty"] or expired["dirty"],
                }
            in_phase = str(active.get("status") or "") in VALID_TASK_PHASES
            resume_note = (
                f"It is in its `{active.get('status')}` phase: you published a diff and are reviewing your own work. "
                "The claim command returns your phase directive."
                if in_phase
                else "This reconnects you to your existing active task instead of claiming a new one. "
                "Continue the task and log evidence."
            )
            directive = (
                f"\n\n---\n"
                f"## Your First Action\n"
                f"You are agent `{args.id}` with role `{args.role}`.\n"
                f"You already have active task `{task_id}`: {task_title}.\n\n"
                f"Run:\n```\nsprintengine task next --role {args.role} --id {args.id}\n```\n\n"
                f"{resume_note}\n\n"
                f"{role_boundary_instruction()}\n\n"
                f"{worker_execution_workspace_block(state, args.state)}\n\n"
                f"{artifact_registration_instruction(args.id)}\n\n"
                f"{completion_reality_instruction()}"
                f"{completion_instruction()}"
                f"If you notice a prompt or process issue that would help improve future Sprint Engine runs, include it with repeatable `--issue-json` on your final feedback command. "
                f"Report concrete bugs, security issues, requirement violations, or test gaps you find and fix with repeatable `--finding-json`. "
                f"When the task is done, stop.\n\n"
                "**IMPORTANT: Do not edit Sprint Engine run-store files directly. "
                "All updates must go through the Sprint Engine tool.**"
            )
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "resume", "task": active, "runner": policy, "prompt": prompt + directive, "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

        # Planner-routed, not architect-routed: in a general-only run the general IS
        # the planner, and gating this on the literal role meant it never received the
        # triage directive — architect-kind needs_input work queued forever.
        if args.role == resolve_planning_role(state) and planner_actionable_needs_input_tasks(state):
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

        if not active and not ready:
            if all_tasks_done(state):
                # Report only. The run reached `completed` through `recompute_phase`
                # at its last publish, every task committed its own scope on the way
                # there (MC-1753), and the user opens the pull request from the run
                # summary. There is no backstop commit and no finalization here.
                return {
                    "ok": True,
                    "role": args.role,
                    "agentId": args.id,
                    "action": "complete",
                    "runner": policy,
                    "message": "All Sprint Engine tasks are done. Stop now.",
                    "releasedExpired": expired["released"],
                    "write": runtime["dirty"] or expired["dirty"],
                }
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "idle", "runner": policy, "message": f"No tasks are currently ready for the '{args.role}' role.", "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

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
            f"When the task is done, stop.\n\n"
            "**IMPORTANT: Do not edit Sprint Engine run-store files directly. "
            "All updates must go through the Sprint Engine tool.**"
        )
        return {"ok": True, "role": args.role, "agentId": args.id, "action": "work", "readyTaskCount": len(ready), "runner": policy, "prompt": prompt + directive, "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"]}

    return with_locked_state(args.state, run)


def cmd_vcs_status(args: argparse.Namespace) -> Dict[str, Any]:
    """Working-tree state, one block per project the run spans.

    The top-level `worktreePath`/`clean`/`dirtyFiles` fields describe the primary
    project, exactly as they always have; `repos` carries the same reading for every
    declared project, so a single-repo run reports one block that says what the
    top-level fields already said.
    """
    from sprintengine_core.tool.paths import resolve_vcs_path, workspace_root_for_state_path
    from sprintengine_core.tool.repo_model import vcs_repos
    from sprintengine_core.tool.shell import git_status_short

    state = load_mutation_state(args.state)
    vcs = get_run_vcs(state)
    if not vcs:
        return {"ok": True, "enabled": False, "vcs": None, "message": "Sprint Engine run is not in worktree mode."}
    workspace_root = workspace_root_for_state_path(args.state)
    repos: List[Dict[str, Any]] = []
    for repo in vcs_repos(vcs):
        worktree = resolve_vcs_path(workspace_root, repo["worktreePath"]) if repo["worktreePath"] else None
        dirty = git_status_short(worktree) if worktree and worktree.exists() else ""
        repos.append({
            "id": repo["id"],
            "worktreePath": repo["worktreePath"],
            "branchName": repo["branchName"],
            "status": repo["status"],
            "clean": not dirty,
            "dirtyFiles": [line.strip() for line in dirty.splitlines() if line.strip()],
        })
    primary = repos[0]
    return {
        "ok": True,
        "enabled": True,
        "vcs": vcs,
        "worktreePath": vcs.get("worktreePath"),
        "branchName": vcs.get("branchName"),
        "clean": primary["clean"],
        "dirtyFiles": primary["dirtyFiles"],
        "repos": repos,
    }


def cmd_vcs_commit(args: argparse.Namespace) -> Dict[str, Any]:
    from sprintengine_core.tool.repo_model import repo_for_task
    from sprintengine_core.tool.shell import (
        commit_run_worktree_paths,
        worktree_for_task,
        worktree_orphaned_dirty_paths,
    )

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        # A canceled run must not land any further commit on its branch, even a
        # manual one (see refuse_if_run_canceled).
        refuse_if_run_canceled(state, "vcs.commit")
        vcs = get_run_vcs(state)
        if not vcs:
            raise SystemExit("Sprint Engine run is not in worktree mode; nothing to commit.")
        task = find_task(state, args.task_id)
        actor = args.id or task.get("ownerAgentId") or task.get("role") or "agent"
        if getattr(args, "summary", None):
            ensure_evidence(task)["summary"] = args.summary
        refresh_task_diff_evidence(state, args.state, task, str(actor), args.path or [])
        sha = commit_run_worktree_paths(state, args.state, task, str(actor), explicit_paths=args.path or [])
        # Everything reported back describes the tree this task commits in — the
        # project it targets — not whatever the primary tree happens to be doing.
        # Worktree mode is established above, so the task always resolves to a repo.
        repo = repo_for_task(state, task)
        worktree = worktree_for_task(state, args.state, task)
        dirty = ""
        if worktree and worktree.exists():
            from sprintengine_core.tool.shell import git_status_short
            dirty = git_status_short(worktree)
        orphaned = worktree_orphaned_dirty_paths(state, args.state, repo)
        recompute_phase(state)
        # The no-op result stays ok:true (committed:false is the contract), but
        # the message is impossible to misread as a landed commit and names the
        # tree that was checked — an agent working the wrong repo worktree sees
        # WHY its commit was empty (MC-1755; the T11 agent read a bare success).
        base_message = (
            f"Committed task {args.task_id} changes as {sha}."
            if sha
            else (
                f"NO-OP: no in-scope changes to commit for task {args.task_id} "
                f"(checked worktree: {repo['worktreePath']}). Nothing was committed — "
                "if you did change files, check you are working in this task's repo "
                "worktree and that the paths are inside its ownedPaths."
            )
        )
        if orphaned:
            base_message += (
                f" WARNING: {len(orphaned)} changed path(s) fall outside every task's owned paths and were NOT committed: "
                f"{', '.join(orphaned)}. If they belong to this task, add them to the task's ownedPaths "
                f"(`sprintengine plan update-task`) or pass `--path <file>`, then commit again — otherwise a clean "
                f"checkout will be missing these files."
            )
        return {
            "ok": True,
            "taskId": args.task_id,
            "repo": repo["id"],
            "committed": bool(sha),
            "commitSha": sha,
            "branchName": repo["branchName"],
            "worktreePath": repo["worktreePath"],
            "clean": not dirty,
            "orphanedUncommittedPaths": orphaned,
            "message": base_message,
        }

    return with_locked_state(args.state, run)


def cmd_vcs_request_repo(args: argparse.Namespace) -> Dict[str, Any]:
    """Bring a new sibling project into a running worktree-mode sprint on demand.

    Reuses init's own provisioning path verbatim — `declared_sibling_entries`
    (which runs the T5 blast-radius gate) to build the entry and
    `ensure_repo_worktree` to create or adopt its tree — then appends the entry to
    `vcs.repos`. The tree is provisioned OUTSIDE the run mutation lock (git worktree
    add / fetch is the slow part, and must not stall a concurrent task.next /
    vcs.commit); the lock is taken only to append the resolved entry after re-checking
    for a concurrent declaration (T7 / backlog 1724). Provision-then-append order still
    holds, so a task that targets the repo after this returns always finds a tree (the
    D4 ordering contract). Re-issuing for an already-declared project adopts its
    existing tree and returns success rather than a duplicate-id error (D5 idempotency).
    """
    from sprintengine_core.tool.paths import resolve_vcs_path, workspace_root_for_state_path
    from sprintengine_core.tool.repo_model import get_run_vcs, vcs_repos
    from sprintengine_core.tool.shell import (
        declared_sibling_entries,
        ensure_repo_worktree,
    )

    snapshot = load_mutation_state(args.state)
    # Snapshot check fails fast before provisioning; the locked append below
    # re-checks so a cancel that races this call still refuses the store write.
    refuse_if_run_canceled(snapshot, "vcs.request_repo")
    vcs = get_run_vcs(snapshot)
    if not vcs:
        raise SystemExit(
            "This sprint is not in worktree mode, so it cannot bring in another project. "
            "Only worktree-mode runs can expand; a single-repo run has no second tree to add."
        )
    raw_root = str(getattr(args, "root", None) or "").strip()
    if not raw_root:
        raise SystemExit("request_repo needs --root <path to the project to bring in>.")
    repo_id = _requested_repo_id(getattr(args, "repo_id", None), raw_root)

    workspace_root = workspace_root_for_state_path(args.state)
    snapshot_repos = vcs_repos(vcs)
    branch = str(snapshot_repos[0].get("branchName") or "").strip()

    # Build the candidate entry through init's own path — this runs the T5 gate
    # (`declared_sibling_root`) and spells the entry shape in one place.
    [candidate] = declared_sibling_entries(
        workspace_root, args.state, [{"id": repo_id, "root": raw_root}], branch=branch
    )
    candidate_root = resolve_vcs_path(workspace_root, candidate["root"]).resolve()

    def is_same_project(entry: Dict[str, Any]) -> bool:
        return resolve_vcs_path(workspace_root, str(entry.get("root") or "")).resolve() == candidate_root

    # A same-id-different-path collision is a caller mistake, not a race: fail fast on
    # the snapshot rather than provisioning a tree only to reject it.
    for stored in snapshot_repos:
        if str(stored.get("id") or "").strip() == repo_id and not is_same_project(stored):
            raise SystemExit(
                f"This sprint already works in a project named {repo_id!r} at a different path. "
                f"Pick a different --repo name for {raw_root}."
            )

    # Create or adopt the tree outside the lock (T7: no network/git work inside
    # the run mutation). A re-issue for an already-declared project — matched by
    # real path, whatever name it was requested under — must ensure the STORED
    # entry's tree: provisioning the name-derived candidate path instead would
    # try to check the run branch out into a second worktree and fail.
    adopt_target = next((stored for stored in snapshot_repos if is_same_project(stored)), None)
    ensure_repo_worktree(workspace_root, adopt_target if adopt_target is not None else candidate)

    def append_entry(state: Dict[str, Any]) -> Dict[str, Any]:
        refuse_if_run_canceled(state, "vcs.request_repo")
        vcs = get_run_vcs(state)
        # Materialize the list shape before appending so a pre-`repos` store keeps its
        # primary as entry zero instead of being replaced by the sibling alone.
        raw_repos = vcs.get("repos")
        if not isinstance(raw_repos, list) or not raw_repos:
            raw_repos = vcs_repos(vcs)
            vcs["repos"] = raw_repos
        for stored in raw_repos:
            if not isinstance(stored, dict):
                continue
            if is_same_project(stored):
                # Already declared (a retry, or a request that raced this one): adopt
                # its stored entry and return success rather than a duplicate.
                return _vcs_request_repo_result(state, args, stored, adopted=True)
            if str(stored.get("id") or "").strip() == repo_id:
                raise SystemExit(
                    f"This sprint already works in a project named {repo_id!r} at a different path. "
                    f"Pick a different --repo name for {raw_root}."
                )
        raw_repos.append(candidate)
        return _vcs_request_repo_result(state, args, candidate, adopted=False)

    return with_locked_state(args.state, append_entry)


def _requested_repo_id(explicit: Optional[str], raw_root: str) -> str:
    """The sibling id for a requested repo: the given one, or the folder name.

    Validated to the same character set init's `--repo <id>=<path>` requires, so a
    tool-provisioned repo and a wizard-declared one carry ids a path and a task
    field can both hold without quoting.
    """
    from sprintengine_core.tool.repo_model import PRIMARY_REPO_ID, SIBLING_REPO_ID_PATTERN

    candidate = str(explicit or "").strip() or Path(raw_root).expanduser().name.strip().lower()
    if not candidate:
        raise SystemExit(f"request_repo could not derive a project name from {raw_root!r}; pass --repo <name>.")
    if candidate == PRIMARY_REPO_ID:
        raise SystemExit(
            f"{PRIMARY_REPO_ID!r} is reserved for this sprint's main project; give the new project a different --repo name."
        )
    if not SIBLING_REPO_ID_PATTERN.match(candidate):
        raise SystemExit(
            f"Project name {candidate!r} is not usable as a project id: use lowercase letters, digits, dots, dashes, "
            "or underscores, starting with a letter or digit. Pass an explicit --repo <name>."
        )
    return candidate


def _vcs_request_repo_result(
    state: Dict[str, Any], args: argparse.Namespace, repo: Dict[str, Any], *, adopted: bool
) -> Dict[str, Any]:
    from sprintengine_core.tool.state import append_event

    verb = "adopted existing" if adopted else "provisioned"
    message = f"Project {repo['id']!r} {verb} at {repo['worktreePath']} on {repo['branchName']}."
    append_event(state, "run_worktree_ready", str(getattr(args, "id", None) or "agent"), message)
    return {
        "action": "vcs_request_repo",
        "adopted": adopted,
        "repo": repo,
        "message": (
            f"Project {repo['id']!r} is ready. Add a task targeting it (repo={repo['id']!r}); "
            "a worker bound to its tree will pick the work up."
        ),
    }


def cmd_vcs_pr(args: argparse.Namespace) -> Dict[str, Any]:
    from sprintengine_core.tool.repo_model import persist_resolved_vcs, repo_field_baseline
    from sprintengine_core.tool.shell import create_run_pull_request

    # Push branches and open pull requests OUTSIDE the run mutation lock: a slow remote
    # must not stall a concurrent task.next / vcs.commit waiting on the same lock. The
    # lock is taken only afterwards, to persist what the network phase resolved onto
    # freshly-loaded state (T7 / backlog 1724).
    snapshot = load_mutation_state(args.state)
    baseline = repo_field_baseline(snapshot)
    since = len(snapshot.get("events") or [])
    result = create_run_pull_request(
        snapshot,
        args.state,
        base=getattr(args, "base", None),
        title=getattr(args, "title", None),
        body=getattr(args, "body", None),
        draft=bool(getattr(args, "draft", False)),
        push=not bool(getattr(args, "no_push", False)),
    )

    def write_result(state: Dict[str, Any]) -> Dict[str, Any]:
        persist_resolved_vcs(state, snapshot, baseline=baseline, since_event_index=since)
        return {"action": "vcs_pr", **result}

    return with_locked_state(args.state, write_result)


def cmd_vcs_pr_merge(args: argparse.Namespace) -> Dict[str, Any]:
    from sprintengine_core.tool.repo_model import persist_resolved_vcs, repo_field_baseline
    from sprintengine_core.tool.shell import merge_repo_pull_request

    # Probe/merge/cleanup run outside the lock; only the resolved state is written under
    # it (T7 / backlog 1724).
    snapshot = load_mutation_state(args.state)
    baseline = repo_field_baseline(snapshot)
    since = len(snapshot.get("events") or [])
    result = merge_repo_pull_request(
        snapshot,
        args.state,
        repo_id=str(getattr(args, "repo", None) or "primary").strip() or "primary",
        method=str(getattr(args, "method", None) or "merge"),
        actor=str(getattr(args, "id", None) or "user"),
    )

    def write_result(state: Dict[str, Any]) -> Dict[str, Any]:
        persist_resolved_vcs(state, snapshot, baseline=baseline, since_event_index=since)
        return {"action": "vcs_pr_merge", **result}

    return with_locked_state(args.state, write_result)


def cmd_vcs_pr_status(args: argparse.Namespace) -> Dict[str, Any]:
    from sprintengine_core.tool.repo_model import (
        get_run_vcs,
        persist_resolved_vcs,
        repo_field_baseline,
        vcs_repos,
    )
    from sprintengine_core.tool.shell import cleanup_merged_worktree, refresh_run_pull_request_state

    # The 30s poll's `gh pr view` / `git fetch` per project runs outside the lock; the
    # lock is taken only to write refreshed states and worktree cleanup (T7 / 1724).
    snapshot = load_mutation_state(args.state)
    baseline = repo_field_baseline(snapshot)
    since = len(snapshot.get("events") or [])
    vcs = get_run_vcs(snapshot)
    prior = {repo["id"]: repo.get("pullRequestState") for repo in vcs_repos(vcs)} if vcs else {}
    result = refresh_run_pull_request_state(snapshot, args.state)
    after = {entry["repo"]: entry["pullRequestState"] for entry in result.get("repos") or []}
    changed = after != prior
    # Auto-remove each project's worktree once ITS branch has merged (clean only).
    if any(pr_state == "merged" for pr_state in after.values()):
        cleanup = cleanup_merged_worktree(snapshot, args.state)
        result["worktreeCleanup"] = cleanup
        if any(entry.get("removed") for entry in cleanup.get("repos") or []):
            changed = True

    def write_result(state: Dict[str, Any]) -> Dict[str, Any]:
        persist_resolved_vcs(state, snapshot, baseline=baseline, since_event_index=since)
        # Avoid rewriting the projection (and re-rendering) when nothing changed — this
        # command polls every 30s while the summary is open.
        return {"action": "vcs_pr_status", **result, **({} if changed else {"write": False})}

    return with_locked_state(args.state, write_result)


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
        "- You MAY use `Sprint Engine plan update-task`, `Sprint Engine plan add-task`, `Sprint Engine plan add-dependency`, or `Sprint Engine plan remove-dependency` only to repair acceptance criteria, add missing real-integration/verification tasks, or make dependencies block fake completion.",
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
        "- `Sprint Engine plan add-task` for missing real-integration or verification tasks",
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

def cmd_cancel(args: argparse.Namespace) -> Dict[str, Any]:
    """Cancel the run under the run lock.

    A lifecycle decision, not a completion: run status → `canceled`, every
    non-`done` task → `canceled` with its owner and lease released, and a single
    `run_canceled` event is appended. Done tasks and their evidence are left
    untouched, and the run worktree/branch (if any) is intentionally left in
    place — parity with completed runs, where the user keeps or deletes the
    branch. Cancel is persisted as a stored run-level flag (`sprintengine.canceled`)
    because it cannot be derived from task statuses: a run whose non-done tasks
    are all `canceled` would otherwise recompute as `completed`.
    """
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        sprintengine = state.setdefault("sprintengine", {})
        actor = str(getattr(args, "id", None) or "user")
        if run_is_canceled(state):
            return {
                "ok": True,
                "action": "cancel",
                "alreadyCanceled": True,
                "status": sprintengine.get("status") or "canceled",
                "canceledTaskIds": [],
                "message": "Run is already canceled.",
                "write": False,
            }
        canceled_task_ids: List[str] = []
        for task in state.get("tasks", []) or []:
            if not isinstance(task, dict) or task.get("status") == "done":
                continue
            from_status = task.get("status")
            task["status"] = "canceled"
            task["ownerAgentId"] = None
            task["completedAt"] = None
            end_lease(task)
            append_task_activity(
                task,
                "status_change",
                actor,
                f"{actor} canceled {task.get('id')} because the run was canceled.",
                {"status": "canceled", "fromStatus": from_status},
            )
            canceled_task_ids.append(str(task.get("id")))
        now = now_iso()
        sprintengine["canceled"] = True
        sprintengine["canceledAt"] = now
        sprintengine["canceledBy"] = actor
        sprintengine["status"] = "canceled"
        event = append_event(
            state,
            "run_canceled",
            actor,
            f"{actor} canceled the run; {len(canceled_task_ids)} task(s) moved to canceled.",
            {"canceledTaskCount": len(canceled_task_ids)},
        )
        # Honors the cancel flag (guarded), so status stays `canceled` rather than
        # rolling up the now done/canceled task set into `completed`.
        recompute_phase(state)
        return {
            "ok": True,
            "action": "cancel",
            "status": "canceled",
            "canceledTaskIds": canceled_task_ids,
            "event": event,
            "message": (
                f"Run canceled; {len(canceled_task_ids)} task(s) moved to canceled. "
                "Done tasks and any run worktree/branch are left in place."
            ),
        }

    return with_locked_state(args.state, run)

def cmd_summary(args: argparse.Namespace) -> Dict[str, Any]:
    """The run rollup, plus whatever the run's trees carry that no task owns.

    The orphan scan is here because this is where the operator decides the run is
    deliverable and opens its pull requests. Every task commits its own scope at
    publish, so anything still dirty and owned by nobody is work that no pull
    request will carry — reported per project, never silently dropped.
    """
    from sprintengine_core.tool.shell import run_orphaned_dirty_paths

    # `git status` per declared tree runs on a snapshot, outside the run mutation
    # lock, so a summary read never stalls a concurrent claim or commit (MC-1724).
    orphaned = run_orphaned_dirty_paths(load_mutation_state(args.state), args.state)

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ok": True,
            "summary": build_run_summary(state),
            "orphanedUncommittedPaths": orphaned,
            "write": False,
        }
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
        if getattr(args, "cli_watch_polling", None):
            current["cliWatchPolling"] = str(args.cli_watch_polling).strip().lower()
        if args.poll_interval_seconds is not None:
            current["pollIntervalSeconds"] = args.poll_interval_seconds
        if args.idle_backoff_seconds is not None:
            current["idleBackoffSeconds"] = args.idle_backoff_seconds
        if args.max_backoff_seconds is not None:
            current["maxBackoffSeconds"] = args.max_backoff_seconds
        if args.stop_when_complete is not None:
            current["stopWhenComplete"] = bool(args.stop_when_complete)
        state["runner"] = folder_store.normalize_runner_policy(current)
        event = append_event(
            state,
            "runner_policy_updated",
            args.actor,
            f"{args.actor} set CLI watch polling to {state['runner']['cliWatchPolling']}.",
        )
        return {"ok": True, "runner": state["runner"], "event": event}

    return with_locked_state(args.state, run)


def cmd_triage_needs_input(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        from sprintengine_core.tool.commands.task import normalized_needs_input_for_routing, planner_actionable_needs_input_tasks

        # Triage belongs to whoever PLANS this run. Hardcoding "architect" forced an
        # architect role onto a general-only run on the first triage call, which the
        # roster boundary then rejected as off-roster — the blocked task could never
        # be triaged by anyone. Validate against configuredRoles instead.
        planning_role = resolve_planning_role(state)
        ensure_role_in_roster(state, planning_role)
        tasks = planner_actionable_needs_input_tasks(state)
        prompt_lines = [
            f"You are the Sprint Engine {planning_role} triaging planner-actionable needs_input tasks.",
            "",
            "Goal:",
            str(state.get("sprintengine", {}).get("goal") or state.get("goal") or ""),
            "",
            "Rules:",
            "- Inspect the blocked task card, notes, evidence, owned paths, and current code before changing the plan.",
            "- `needsInput.kind` routes who acts next: architect for automatic architect triage or user for human/operator input. Use `reason` for artifact, tooling, verification, product, and task-scope classification.",
            "- Resolve planning defects by updating task cards or adding follow-up tasks; do not edit application source in this triage mode.",
            "- A blocker carrying a Finding id is a reviewer task-filing request: file the follow-up with `sprintengine plan add-task --from-finding-task-id <task> --from-finding-id <finding>` so the finding chain survives the run. Done stays terminal — never reopen the card the finding was found on.",
            "- For reason=artifact_review, read the referenced artifact, adjudicate recommended follow-up tasks, wire blockers before validation when needed, then approve/request changes or resolve the blocked task.",
            "- Use `sprintengine plan update-task --force` for active task-card corrections.",
            "- Use `sprintengine plan add-task`, `sprintengine plan add-dependency`, or `sprintengine plan remove-dependency` only when the task graph really needs repair.",
            f"- When the original owner should continue, use `sprintengine task resolve-input --task-id <id> --id {args.id} --resolution \"...\"` instead of plain `task status --status in_progress` so the owner receives a resume notification.",
            f"- When planner adjudication completes a review-only blocked task, use `sprintengine task resolve-input --task-id <id> --id {args.id} --resolution \"...\" --complete`.",
            f"- If the original owner is inactive or should not continue, use `sprintengine task release --task-id <id> --id {args.id} --reason \"...\"`.",
            "- Leave human-owned decisions as `needs_input` with kind=user; do not guess product intent.",
            "- When the worker can continue, say so clearly in the note. The original worker still owns implementation and completion evidence.",
            "",
        ]
        # Hot-seam signals (MC-1822) ride the same planner-routed lane as
        # needs_input: they are addressed to whoever plans this run, and the
        # decision they ask for — plan a checkpoint review task over this seam,
        # or note why not — is a planning decision only the architect makes.
        # They are reported here as INFORMATION; nothing about the plan changes
        # unless the architect changes it.
        seam_lines: List[str] = []
        for entry in state.get("seamSignals", []) or []:
            if not isinstance(entry, dict):
                continue
            seam_lines.append(
                f"- Seam `{entry.get('seam')}`: {entry.get('landedCount')} tasks have published "
                f"changes to it ({', '.join(entry.get('ownerTaskIds') or [])}). Compare against the "
                "plan's `## Seams` map: if this seam went unmapped or has more owners than "
                "predicted, consider adding a checkpoint review task depending on those tasks. "
                "Record the decision either way."
            )
        if seam_lines:
            prompt_lines.extend(["Hot seams (information — you decide, the engine never adds tasks):", *seam_lines, ""])

        if not tasks:
            prompt_lines.extend([
                "No planner-actionable needs_input tasks are currently queued.",
                "Stop now." if not seam_lines else "Act on the hot-seam signals above, then stop.",
            ])
            return {
                "ok": True,
                "tasks": [],
                **({"seamSignals": list(state.get("seamSignals") or [])} if seam_lines else {}),
                "prompt": "\n".join(prompt_lines),
                "write": False,
            }

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
                # A reviewer task-filing request names the structured finding it
                # is about. File the follow-up task with
                # `--from-finding-task-id <task> --from-finding-id <finding>` so
                # the finding chain survives the run instead of dying in prose.
                f"  Finding id: {needs_input.get('findingId') or '(not provided)'}",
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
            **({"seamSignals": list(state.get("seamSignals") or [])} if seam_lines else {}),
            "prompt": "\n".join(prompt_lines),
            "write": False,
        }

    return with_locked_state(args.state, run)

cancel = cmd_cancel
handover = cmd_handover
init = cmd_init
join = cmd_join
recover = cmd_recover
summary = cmd_summary
projection = cmd_projection
runner_status = cmd_runner_status
runner_set = cmd_runner_set
triage_needs_input = cmd_triage_needs_input
vcs_status = cmd_vcs_status
vcs_commit = cmd_vcs_commit
vcs_request_repo = cmd_vcs_request_repo
vcs_pr = cmd_vcs_pr
vcs_pr_status = cmd_vcs_pr_status
vcs_pr_merge = cmd_vcs_pr_merge
