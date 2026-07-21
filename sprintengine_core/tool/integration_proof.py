"""Structural integration-proof gate and seam manifest (MC-1742)."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from sprintengine_core.tool.paths import now_iso, resolve_vcs_path, workspace_root_for_state_path
from sprintengine_core.tool.shell import get_run_vcs, run_git_checked, vcs_repos
from sprintengine_core.tool.task_reviews import open_review_request

PROOF_TASK_KIND = "integration_proof"
VALID_PROOF_MODES = {"app_drive", "engine_smoke", "human_smoke"}
VALID_PROOF_STATUSES = {"pending", "running", "needs_human", "valid", "invalidated"}
VALID_SEAM_KINDS = {"ipc", "protocol", "store", "event", "service", "cross_repo", "other"}
VALID_SEAM_DISPOSITIONS = {"connected", "dangling"}


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def is_proof_task(task: Dict[str, Any]) -> bool:
    return str(task.get("kind") or "work") == PROOF_TASK_KIND


def normalize_integration_proof(raw: Any) -> Dict[str, Any]:
    record = raw if isinstance(raw, dict) else {}
    status = str(record.get("status") or "pending").strip()
    if status not in VALID_PROOF_STATUSES:
        status = "pending"
    mode = str(record.get("mode") or "").strip()
    result: Dict[str, Any] = {
        "required": bool(record.get("required")),
        "status": status,
        "revision": _non_negative_int(record.get("revision")),
        "graphRevision": _non_negative_int(record.get("graphRevision")),
    }
    for key in ("taskId", "artifactId", "invalidatedReason", "exemptionRationale"):
        value = str(record.get(key) or "").strip()
        if value:
            result[key] = value
    if mode in VALID_PROOF_MODES:
        result["mode"] = mode
    heads = normalize_repository_heads(record.get("verifiedHeads"))
    if heads:
        result["verifiedHeads"] = heads
    approval = record.get("humanApproval")
    if isinstance(approval, dict):
        approved_at = str(approval.get("approvedAt") or "").strip()
        artifact_id = str(approval.get("evidenceArtifactId") or "").strip()
        if approved_at and artifact_id and approval.get("actor") == "local_user":
            result["humanApproval"] = {
                "approvedAt": approved_at,
                "actor": "local_user",
                "evidenceArtifactId": artifact_id,
            }
    return result


def normalize_repository_heads(raw: Any) -> List[Dict[str, str]]:
    if not isinstance(raw, list):
        return []
    heads: List[Dict[str, str]] = []
    seen: set[str] = set()
    for value in raw:
        if not isinstance(value, dict):
            continue
        repo = str(value.get("repo") or "").strip()
        sha = str(value.get("sha") or "").strip()
        if repo and sha and repo not in seen:
            heads.append({"repo": repo, "sha": sha})
            seen.add(repo)
    return heads


def normalize_integration_seams(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    seams: List[Dict[str, Any]] = []
    for value in raw:
        if not isinstance(value, dict):
            continue
        seam_id = str(value.get("id") or "").strip()
        kind = str(value.get("kind") or "").strip()
        producer = str(value.get("producerTaskId") or "").strip()
        disposition = str(value.get("disposition") or "").strip()
        if not seam_id or kind not in VALID_SEAM_KINDS or not producer or disposition not in VALID_SEAM_DISPOSITIONS:
            continue
        seam: Dict[str, Any] = {
            "id": seam_id,
            "kind": kind,
            "producerTaskId": producer,
            "consumerTaskIds": _strings(value.get("consumerTaskIds")),
            "acceptanceCritical": bool(value.get("acceptanceCritical")),
            "disposition": disposition,
        }
        rationale = str(value.get("rationale") or "").strip()
        if rationale:
            seam["rationale"] = rationale
        follow_up = value.get("followUp")
        if (
            isinstance(follow_up, dict)
            and isinstance(follow_up.get("backlogId"), int)
            and not isinstance(follow_up.get("backlogId"), bool)
            and follow_up["backlogId"] > 0
        ):
            normalized_follow_up: Dict[str, Any] = {"backlogId": follow_up["backlogId"]}
            for key in ("repo", "path"):
                text = str(follow_up.get(key) or "").strip()
                if text:
                    normalized_follow_up[key] = text
            seam["followUp"] = normalized_follow_up
        seams.append(seam)
    return seams


def _strings(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    result: List[str] = []
    for value in raw:
        text = str(value or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def _graph_payload(state: Dict[str, Any]) -> Dict[str, Any]:
    tasks = []
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict) or is_proof_task(task):
            continue
        tasks.append({
            "id": str(task.get("id") or ""),
            "status": str(task.get("status") or ""),
            "dependsOn": sorted(_strings(task.get("dependsOn"))),
            "repo": str(task.get("repo") or "primary"),
            "producesSeamIds": sorted(_strings(task.get("producesSeamIds"))),
            "consumesSeamIds": sorted(_strings(task.get("consumesSeamIds"))),
            "openReviewRequest": bool(open_review_request(task)),
        })
    proof = normalize_integration_proof(state.get("integrationProof"))
    return {
        "tasks": sorted(tasks, key=lambda entry: entry["id"]),
        "seams": sorted(normalize_integration_seams(state.get("integrationSeams")), key=lambda entry: entry["id"]),
        "proofPolicy": {
            "required": proof.get("required", False),
            "taskId": proof.get("taskId", ""),
            "mode": proof.get("mode", ""),
        },
    }


def _graph_fingerprint(state: Dict[str, Any]) -> str:
    encoded = json.dumps(_graph_payload(state), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def capture_repository_heads(state: Dict[str, Any], state_path: Path) -> List[Dict[str, str]]:
    workspace_root = workspace_root_for_state_path(state_path)
    vcs = get_run_vcs(state)
    entries = vcs_repos(vcs) if vcs else [{"id": "primary", "root": ".", "worktreePath": "."}]
    heads: List[Dict[str, str]] = []
    for entry in entries:
        repo_id = str(entry.get("id") or "").strip()
        worktree_value = str(entry.get("worktreePath") or "").strip()
        root_value = str(entry.get("root") or ".").strip()
        candidate = resolve_vcs_path(workspace_root, worktree_value) if worktree_value else None
        cwd = candidate if candidate and candidate.exists() else resolve_vcs_path(workspace_root, root_value)
        result = run_git_checked(cwd, ["rev-parse", "HEAD"], allow_failure=True)
        sha = result.stdout.strip()
        if result.returncode != 0 or not sha:
            raise SystemExit(f"integration_proof_head_unavailable: cannot resolve HEAD for project {repo_id} at {cwd}.")
        heads.append({"repo": repo_id, "sha": sha})
    return heads


def proof_barrier_open(state: Dict[str, Any], proof_task_id: Optional[str] = None) -> bool:
    task_id = str(proof_task_id or normalize_integration_proof(state.get("integrationProof")).get("taskId") or "")
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict) or str(task.get("id") or "") == task_id or is_proof_task(task):
            continue
        if task.get("status") == "canceled":
            continue
        if task.get("status") != "done" or open_review_request(task):
            return False
    return not any(
        open_review_request(task)
        for task in state.get("tasks", []) or []
        if isinstance(task, dict)
    )


def invalidate_integration_proof(state: Dict[str, Any], reason: str) -> bool:
    if "integrationProof" not in state:
        return False
    proof = normalize_integration_proof(state.get("integrationProof"))
    if proof.get("status") in {"pending", "invalidated"} and proof.get("invalidatedReason") == reason:
        state["integrationProof"] = proof
        return False
    proof["status"] = "invalidated"
    proof["invalidatedReason"] = reason
    proof.pop("humanApproval", None)
    state["integrationProof"] = proof
    proof_task = next(
        (task for task in state.get("tasks", []) or [] if isinstance(task, dict) and str(task.get("id")) == str(proof.get("taskId") or "")),
        None,
    )
    if isinstance(proof_task, dict) and proof_task.get("status") not in {"canceled", "todo"}:
        proof_task["status"] = "todo"
        proof_task["ownerAgentId"] = None
        proof_task["completedAt"] = None
        proof_task.pop("lease", None)
        proof_task.pop("needsInput", None)
    sprintengine = state.get("sprintengine")
    if isinstance(sprintengine, dict) and sprintengine.get("status") == "completed":
        # Reconciliation runs after every mutation. If that mutation changed a
        # graph/head after an earlier completion roll-up, fail closed in the
        # same locked write instead of leaving run.status stale until the next
        # command happens to recompute it.
        sprintengine["status"] = "executing"
        sprintengine["completedAt"] = None
    return True


def reconcile_integration_proof(state: Dict[str, Any], state_path: Path, *, check_heads: bool = True) -> bool:
    """Refresh graph/head freshness under the caller's existing run lock."""
    if "integrationProof" not in state:
        return False
    dirty = False
    proof = normalize_integration_proof(state.get("integrationProof"))
    fingerprint = _graph_fingerprint(state)
    previous = str(state.get("integrationGraphFingerprint") or "")
    if previous != fingerprint:
        proof["graphRevision"] = int(proof.get("graphRevision") or 0) + (1 if previous else 0)
        state["integrationGraphFingerprint"] = fingerprint
        if previous and proof.get("status") in {"running", "needs_human", "valid"}:
            state["integrationProof"] = proof
            invalidate_integration_proof(state, "task graph, task lifecycle, review obligation, or seam manifest changed")
            proof = normalize_integration_proof(state.get("integrationProof"))
        dirty = True
    if check_heads and proof.get("status") in {"needs_human", "valid"} and proof.get("verifiedHeads"):
        current_heads = capture_repository_heads(state, state_path)
        if current_heads != proof.get("verifiedHeads"):
            state["integrationProof"] = proof
            invalidate_integration_proof(state, "declared repository HEAD changed")
            proof = normalize_integration_proof(state.get("integrationProof"))
            dirty = True
    state["integrationProof"] = proof
    return dirty


def integration_proof_satisfies_completion(state: Dict[str, Any]) -> bool:
    if any(open_review_request(task) for task in state.get("tasks", []) or [] if isinstance(task, dict)):
        return False
    proof = normalize_integration_proof(state.get("integrationProof"))
    if not proof.get("required"):
        return True
    proof_task = next(
        (
            task for task in state.get("tasks", []) or []
            if isinstance(task, dict) and str(task.get("id") or "") == str(proof.get("taskId") or "")
        ),
        None,
    )
    return (
        proof.get("status") == "valid"
        and bool(proof.get("artifactId"))
        and isinstance(proof_task, dict)
        and is_proof_task(proof_task)
        and proof_task.get("status") == "done"
        and int(proof.get("graphRevision") or 0) >= 0
    )


def run_is_complete(state: Dict[str, Any]) -> bool:
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    if not tasks:
        return False
    if any(task.get("status") not in {"done", "canceled"} for task in tasks):
        return False
    return integration_proof_satisfies_completion(state)


def _depends_transitively(tasks_by_id: Dict[str, Dict[str, Any]], consumer_id: str, producer_id: str) -> bool:
    pending = list((tasks_by_id.get(consumer_id) or {}).get("dependsOn", []) or [])
    seen: set[str] = set()
    while pending:
        candidate = str(pending.pop()).strip()
        if candidate == producer_id:
            return True
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        pending.extend((tasks_by_id.get(candidate) or {}).get("dependsOn", []) or [])
    return False


def _follow_up_is_open(state_path: Path, follow_up: Dict[str, Any]) -> bool:
    relative = str(follow_up.get("path") or "").strip()
    if not relative or Path(relative).is_absolute() or not relative.startswith("backlog/"):
        return False
    backlog_root = (workspace_root_for_state_path(state_path) / "backlog").resolve()
    path = (workspace_root_for_state_path(state_path) / relative).resolve()
    if backlog_root not in path.parents:
        return False
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    id_match = re.search(r"(?m)^id:\s*(\d+)\s*$", text)
    status_match = re.search(r"(?m)^status:\s*([a-z_]+)\s*$", text)
    return (
        bool(id_match)
        and int(id_match.group(1)) == int(follow_up.get("backlogId") or -1)
        and bool(status_match)
        and status_match.group(1) not in {"completed", "archived"}
    )


def validate_integration_plan(state: Dict[str, Any], state_path: Path) -> List[str]:
    """Fail closed on proof/seam structure; return warning-only diff heuristics."""
    if "integrationProof" not in state:
        return []  # pre-MC-1742 run: additive old-run compatibility
    proof = normalize_integration_proof(state.get("integrationProof"))
    raw_seams = state.get("integrationSeams")
    if not isinstance(raw_seams, list):
        raise SystemExit("integration_seam_manifest_invalid: integrationSeams must be an array.")
    seams = normalize_integration_seams(raw_seams)
    if len(seams) != len(raw_seams):
        raise SystemExit("integration_seam_manifest_invalid: every seam needs a valid id, kind, producer, disposition, and follow-up shape.")
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict) and task.get("status") != "canceled"]
    tasks_by_id = {str(task.get("id")): task for task in tasks if task.get("id")}
    proof_tasks = [task for task in tasks if is_proof_task(task)]
    code_tasks = [task for task in tasks if not is_proof_task(task) and bool(task.get("producesImplementation"))]

    if proof.get("required"):
        if proof.get("mode") not in VALID_PROOF_MODES:
            raise SystemExit("integration_proof_mode_required: required proof needs app_drive, engine_smoke, or human_smoke mode.")
        if len(proof_tasks) != 1:
            raise SystemExit("integration_proof_task_count: a required run must contain exactly one integration_proof task.")
        if proof.get("taskId") != proof_tasks[0].get("id"):
            raise SystemExit("integration_proof_task_mismatch: policy taskId must name the canonical proof task.")
        if proof_tasks[0].get("ownedPaths"):
            raise SystemExit("integration_proof_edit_scope: the proof task may not own product paths.")
    else:
        if code_tasks:
            raise SystemExit("integration_proof_required_for_code: a code-producing plan cannot use the proof exemption.")
        if not str(proof.get("exemptionRationale") or "").strip():
            raise SystemExit("integration_proof_exemption_rationale_required: explain why this run produces no product code.")

    seam_ids = [seam["id"] for seam in seams]
    if len(seam_ids) != len(set(seam_ids)):
        raise SystemExit("integration_seam_duplicate: seam ids must be unique.")
    for task in code_tasks:
        if not isinstance(task.get("producesSeamIds"), list) or not isinstance(task.get("consumesSeamIds"), list):
            raise SystemExit(f"integration_seam_declaration_required: code task {task.get('id')} must declare producesSeamIds and consumesSeamIds, including empty arrays.")
        unknown = sorted(set(_strings(task.get("producesSeamIds")) + _strings(task.get("consumesSeamIds"))) - set(seam_ids))
        if unknown:
            raise SystemExit(f"integration_seam_unknown_declaration: task {task.get('id')} names missing seam(s): {', '.join(unknown)}.")
    for seam in seams:
        seam_id = seam["id"]
        producer = tasks_by_id.get(seam["producerTaskId"])
        if not producer or seam_id not in _strings(producer.get("producesSeamIds")):
            raise SystemExit(f"integration_seam_producer_mismatch: {seam_id} is not declared by {seam['producerTaskId']}.")
        if is_proof_task(producer):
            raise SystemExit(f"integration_seam_proof_not_producer: proof task cannot produce product seam {seam_id}.")
        consumers = seam["consumerTaskIds"]
        if seam["disposition"] == "connected" and not consumers:
            raise SystemExit(f"integration_seam_consumer_required: connected seam {seam_id} needs an in-run consumer.")
        for consumer_id in consumers:
            consumer = tasks_by_id.get(consumer_id)
            if not consumer or seam_id not in _strings(consumer.get("consumesSeamIds")):
                raise SystemExit(f"integration_seam_consumer_mismatch: {consumer_id} does not consume {seam_id}.")
            if not _depends_transitively(tasks_by_id, consumer_id, seam["producerTaskId"]):
                raise SystemExit(f"integration_seam_dependency_missing: {consumer_id} must depend transitively on {seam['producerTaskId']} for {seam_id}.")
            if is_proof_task(consumer):
                raise SystemExit(f"integration_seam_proof_not_consumer: proof task cannot be the product consumer for {seam_id}.")
        if seam["disposition"] == "dangling":
            if seam["acceptanceCritical"] or consumers or not str(seam.get("rationale") or "").strip():
                raise SystemExit(f"integration_seam_invalid_dangling: {seam_id} must be non-critical, consumer-free, and rationalized.")
            if not isinstance(seam.get("followUp"), dict) or not _follow_up_is_open(state_path, seam["followUp"]):
                raise SystemExit(f"integration_seam_follow_up_required: dangling seam {seam_id} needs an existing open backlog follow-up.")
    if proof.get("required") and proof_tasks:
        acceptance = "\n".join(_strings(proof_tasks[0].get("acceptanceCriteria")))
        missing = [seam["id"] for seam in seams if seam["acceptanceCritical"] and seam["id"] not in acceptance]
        if missing:
            raise SystemExit(f"integration_proof_acceptance_missing_seams: proof acceptance must name {', '.join(missing)}.")

    warnings: List[str] = []
    for task in code_tasks:
        paths = " ".join(_strings(task.get("ownedPaths"))).lower()
        if any(token in paths for token in ("ipc", "protocol", "store", "service")) and not (
            _strings(task.get("producesSeamIds")) or _strings(task.get("consumesSeamIds"))
        ):
            warnings.append(f"Task {task.get('id')} changes a likely integration boundary but declares no seams.")
    state["integrationProof"] = proof
    state["integrationSeams"] = seams
    return warnings


def begin_integration_proof(state: Dict[str, Any], state_path: Path, task: Dict[str, Any], actor: str) -> Dict[str, Any]:
    proof = normalize_integration_proof(state.get("integrationProof"))
    if not proof.get("required") or proof.get("taskId") != task.get("id") or not is_proof_task(task):
        raise SystemExit("integration_proof_task_mismatch: begin must target the canonical required proof task.")
    if str(task.get("ownerAgentId") or "") != str(actor or "") or task.get("status") != "in_progress":
        raise SystemExit("integration_proof_owner_required: claim the proof task before beginning.")
    if not proof_barrier_open(state, str(task.get("id") or "")):
        raise SystemExit("integration_proof_barrier_closed: all non-proof work and review obligations must close first.")
    proof["revision"] = int(proof.get("revision") or 0) + 1
    proof["status"] = "running"
    proof["graphRevision"] = int(proof.get("graphRevision") or 0)
    proof["verifiedHeads"] = capture_repository_heads(state, state_path)
    proof.pop("artifactId", None)
    proof.pop("invalidatedReason", None)
    proof.pop("humanApproval", None)
    state["integrationProof"] = proof
    return proof


def validate_proof_artifact(
    state: Dict[str, Any],
    state_path: Path,
    payload: Any,
    *,
    allow_partial: bool = False,
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise SystemExit("integration_proof_artifact_invalid: artifact JSON must be an object.")
    proof = normalize_integration_proof(state.get("integrationProof"))
    required_scalars = {
        "runId": state_path.parent.name,
        "proofRevision": proof.get("revision"),
        "mode": proof.get("mode"),
        "graphRevision": proof.get("graphRevision"),
    }
    for key, expected in required_scalars.items():
        if payload.get(key) != expected:
            raise SystemExit(f"integration_proof_artifact_stale: {key} must equal the engine-captured value {expected!r}.")
    if normalize_repository_heads(payload.get("repositoryHeads")) != proof.get("verifiedHeads"):
        raise SystemExit("integration_proof_artifact_stale: repositoryHeads do not match the engine capture.")
    nonproof_ids = {
        str(task.get("id")) for task in state.get("tasks", []) or []
        if isinstance(task, dict) and not is_proof_task(task) and task.get("status") != "canceled"
    }
    if set(_strings(payload.get("coveredTaskIds"))) != nonproof_ids:
        raise SystemExit("integration_proof_coverage_missing: coveredTaskIds must include every non-canceled work task.")
    critical_seams = {
        seam["id"] for seam in normalize_integration_seams(state.get("integrationSeams"))
        if seam.get("acceptanceCritical")
    }
    if not critical_seams.issubset(set(_strings(payload.get("coveredSeamIds")))):
        raise SystemExit("integration_proof_coverage_missing: every acceptance-critical seam must be covered.")
    scenarios = payload.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        raise SystemExit("integration_proof_scenarios_required: at least one structured scenario is required.")
    artifact_root = state_path.parent.resolve()
    saw_partial = False
    all_paths: List[str] = []
    for scenario in scenarios:
        if not isinstance(scenario, dict) or not all(str(scenario.get(key) or "").strip() for key in ("id", "action", "expected")):
            raise SystemExit("integration_proof_scenario_invalid: scenario id/action/expected are required.")
        outcome = str(scenario.get("outcome") or "")
        if outcome == "partial":
            saw_partial = True
        if outcome == "failed" or outcome not in {"passed", "partial"} or (outcome == "partial" and not allow_partial):
            raise SystemExit("integration_proof_scenario_failed: valid automated proof permits only passed scenarios.")
        paths = _strings(scenario.get("evidencePaths"))
        if not paths:
            raise SystemExit("integration_proof_evidence_required: every scenario needs evidence paths.")
        for raw_path in paths:
            path = (artifact_root / raw_path).resolve()
            if artifact_root not in path.parents or not path.is_file():
                raise SystemExit(f"integration_proof_evidence_path_invalid: {raw_path} must be an existing file under the run artifact root.")
        all_paths.extend(paths)
    commands = payload.get("commands")
    declared_repos = {head["repo"] for head in proof.get("verifiedHeads", [])}
    if not isinstance(commands, list) or not commands or any(
        not isinstance(command, dict)
        or not str(command.get("cwdRepo") or "").strip()
        or not str(command.get("command") or "").strip()
        or not isinstance(command.get("exitCode"), int)
        or isinstance(command.get("exitCode"), bool)
        or command.get("exitCode") != 0
        or str(command.get("cwdRepo") or "").strip() not in declared_repos
        for command in commands
    ):
        raise SystemExit("integration_proof_commands_invalid: record successful real commands with cwdRepo, command, and exitCode=0.")
    gates = payload.get("gateResults")
    if not isinstance(gates, list) or not gates or any(
        not isinstance(gate, dict) or not str(gate.get("name") or "").strip() or gate.get("outcome") != "passed"
        for gate in gates
    ):
        raise SystemExit("integration_proof_gates_failed: every required gate result must be present and passed.")
    for gate in gates:
        report_path = str(gate.get("reportPath") or "").strip()
        if not report_path:
            continue
        resolved_report = (artifact_root / report_path).resolve()
        if artifact_root not in resolved_report.parents or not resolved_report.is_file():
            raise SystemExit(f"integration_proof_gate_report_invalid: {report_path} must be an existing file under the run artifact root.")
    if proof.get("mode") == "app_drive":
        if not any("trace" in path.lower() for path in all_paths):
            raise SystemExit("integration_proof_app_trace_required: app_drive needs a Playwright trace, not screenshots/prose alone.")
        if not any(any(token in path.lower() for token in ("assert", "output", "report")) for path in all_paths):
            raise SystemExit("integration_proof_app_assertions_required: app_drive needs assertion output in addition to its trace.")
    if proof.get("mode") == "engine_smoke" and not any(
        any(token in path.lower() for token in ("state", "event", "log", "output"))
        for path in all_paths
    ):
        raise SystemExit("integration_proof_engine_state_required: engine_smoke needs canonical state, event, log, or assertion output evidence.")
    if proof.get("mode") == "human_smoke" and not saw_partial and allow_partial:
        raise SystemExit("integration_proof_human_partial_required: human smoke request must identify a partial scenario.")
    return dict(payload)


def complete_automated_proof(state: Dict[str, Any], state_path: Path, task: Dict[str, Any], artifact_id: str, payload: Any) -> Dict[str, Any]:
    proof = normalize_integration_proof(state.get("integrationProof"))
    if proof.get("status") != "running" or proof.get("taskId") != task.get("id"):
        raise SystemExit("integration_proof_not_running: begin a fresh proof attempt first.")
    if proof.get("mode") == "human_smoke":
        raise SystemExit("integration_proof_human_request_required: human_smoke must publish partial evidence through proof.request_human.")
    reconcile_integration_proof(state, state_path)
    proof = normalize_integration_proof(state.get("integrationProof"))
    if proof.get("status") != "running":
        raise SystemExit("integration_proof_invalidated: graph or repository heads changed during proof.")
    validated = validate_proof_artifact(state, state_path, payload)
    proof["status"] = "valid"
    proof["artifactId"] = artifact_id
    proof.pop("invalidatedReason", None)
    state["integrationProof"] = proof
    task["status"] = "done"
    task["completedAt"] = now_iso()
    task["lastImplementedByAgentId"] = str(task.get("ownerAgentId") or "") or None
    task["ownerAgentId"] = None
    task.pop("lease", None)
    return {"proof": proof, "artifact": validated}


def request_human_proof(state: Dict[str, Any], state_path: Path, task: Dict[str, Any], artifact_id: str, payload: Any, blocker: str) -> Dict[str, Any]:
    clean_blocker = str(blocker or "").strip()
    if not clean_blocker:
        raise SystemExit("integration_proof_automation_blocker_required: explain the concrete automation blocker.")
    proof = normalize_integration_proof(state.get("integrationProof"))
    if (
        proof.get("status") != "running"
        or proof.get("mode") != "human_smoke"
        or proof.get("taskId") != task.get("id")
        or not is_proof_task(task)
    ):
        raise SystemExit("integration_proof_human_mode_required: begin a human_smoke proof attempt first.")
    reconcile_integration_proof(state, state_path)
    proof = normalize_integration_proof(state.get("integrationProof"))
    if proof.get("status") != "running":
        raise SystemExit("integration_proof_invalidated: graph or repository heads changed during proof.")
    validated = validate_proof_artifact(state, state_path, payload, allow_partial=True)
    proof["status"] = "needs_human"
    proof["artifactId"] = artifact_id
    state["integrationProof"] = proof
    task["status"] = "needs_input"
    task["completedAt"] = None
    task["needsInput"] = {
        "kind": "user",
        "reason": "verification",
        "question": clean_blocker,
        "suggestedResolution": "Run the exact remaining smoke actions and approve the current proof revision in Sprint Engine Studio.",
        "reportedBy": str(task.get("ownerAgentId") or "proof-agent"),
        "reportedAt": now_iso(),
    }
    return {"proof": proof, "artifact": validated}


def approve_human_proof(state: Dict[str, Any], state_path: Path, task: Dict[str, Any], artifact_id: str, actor: str) -> Dict[str, Any]:
    if actor != "local_user":
        raise SystemExit("integration_proof_local_user_required: agent/MCP identities cannot approve human smoke.")
    reconcile_integration_proof(state, state_path)
    proof = normalize_integration_proof(state.get("integrationProof"))
    if (
        proof.get("status") != "needs_human"
        or proof.get("artifactId") != artifact_id
        or proof.get("taskId") != task.get("id")
        or not is_proof_task(task)
    ):
        raise SystemExit("integration_proof_human_approval_stale: current proof revision is not awaiting this artifact.")
    proof["status"] = "valid"
    proof["humanApproval"] = {
        "approvedAt": now_iso(),
        "actor": "local_user",
        "evidenceArtifactId": artifact_id,
    }
    state["integrationProof"] = proof
    task["status"] = "done"
    task["completedAt"] = now_iso()
    task["lastImplementedByAgentId"] = str(task.get("ownerAgentId") or "") or None
    task["ownerAgentId"] = None
    task.pop("lease", None)
    task.pop("needsInput", None)
    return proof
