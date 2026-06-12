"""Quality gate state transitions and verdict helpers."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.tool.comments import latest_implementation_comment
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.state import *  # noqa: F403,F401

def canonical_gate_role(gate: Dict[str, Any]) -> str:
    raw_role = str(gate.get("role") or "").strip()
    if not raw_role:
        return ""
    return require_configured_role(raw_role, context=f"Gate {gate.get('id') or 'unknown'}")

def find_active_gate_claim(state: Dict[str, Any], agent_id: str, role: str) -> Optional[Dict[str, Any]]:
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        for gate in task_quality_gates(task):
            if canonical_gate_role(gate) != role or gate.get("status") != "in_progress":
                continue
            for attempt in reversed(gate_attempts(gate)):
                if (
                    isinstance(attempt, dict)
                    and attempt.get("status") == "in_progress"
                    and attempt.get("claimedBy") == agent_id
                ):
                    return {"task": task, "gate": gate, "attempt": attempt}
    return None

def latest_implementer_agent_id(task: Dict[str, Any]) -> Optional[str]:
    attributed = str(task.get("lastImplementedByAgentId") or "").strip()
    if attributed:
        return attributed
    comment = latest_implementation_comment(task)
    if not comment:
        return None
    author = str(comment.get("authorAgentId") or comment.get("actor") or "").strip()
    return author or None

def gate_is_claimable_for_role(task: Dict[str, Any], gate: Dict[str, Any], role: str, agent_id: str) -> bool:
    if canonical_gate_role(gate) != role or gate.get("status") != "pending":
        return False
    if str(task.get("status") or "") != str(gate.get("phase") or ""):
        return False
    if gate.get("allowSelfReview") is False and latest_implementer_agent_id(task) == agent_id:
        return False
    return True

def claim_gate_for_agent(state: Dict[str, Any], task: Dict[str, Any], gate: Dict[str, Any], role: str, agent_id: str) -> Dict[str, Any]:
    if not gate_is_claimable_for_role(task, gate, role, agent_id):
        raise SystemExit("Gate is not claimable for this role and agent.")
    now = now_iso()
    gate["role"] = role
    gate["status"] = "in_progress"
    attempt = {
        "id": next_gate_attempt_id(gate),
        "status": "in_progress",
        "role": role,
        "claimedBy": agent_id,
        "startedAt": now,
    }
    gate_attempts(gate).append(attempt)
    agent = ensure_agent(state, agent_id, role)
    agent["status"] = "running"
    agent["currentTaskId"] = task.get("id")
    agent["currentGateId"] = gate.get("id")
    agent["currentGate"] = {"taskId": task.get("id"), "gateId": gate.get("id"), "attemptId": attempt["id"]}
    dispatch = queue_dispatch_record(
        state,
        agent_id=agent_id,
        role=role,
        target_kind="gate",
        task_id=str(task.get("id") or ""),
        task_status=str(task.get("status") or ""),
        gate_id=str(gate.get("id") or ""),
        gate_status=str(gate.get("status") or ""),
        attempt_id=attempt["id"],
        reason="gate_claimed",
    )
    agent["currentDispatch"] = current_dispatch_payload(
        dispatch_id=dispatch["id"],
        target_kind="gate",
        role=role,
        reason="gate_claimed",
        task_id=str(task.get("id") or ""),
        gate_id=str(gate.get("id") or ""),
        attempt_id=attempt["id"],
        assigned_at=dispatch["timestamp"],
    )
    agent["lastDirectiveAt"] = dispatch["timestamp"]
    record_dispatch_cursor(
        state,
        role=role,
        target_kind="gate",
        target_key=dispatch_target_key("gate", task.get("id"), gate.get("id")),
    )
    append_task_activity(
        task,
        "gate_claim",
        agent_id,
        f"{agent_id} claimed gate {gate.get('id')} on {task.get('id')}.",
        {"gateId": gate.get("id"), "gateRole": role, "gatePhase": gate.get("phase"), "attemptId": attempt["id"]},
    )
    return {"task": task, "gate": gate, "attempt": attempt, "agent": agent}

def gate_phase_order() -> List[str]:
    return ["review", "testing", "product"]

def reset_required_gates_for_rework(task: Dict[str, Any]) -> None:
    for gate in task_quality_gates(task):
        if gate.get("required") is False or gate.get("status") == "skipped":
            continue
        gate["status"] = "pending"
        for attempt in gate_attempts(gate):
            if isinstance(attempt, dict) and attempt.get("status") == "in_progress":
                attempt["status"] = "superseded"
                attempt["completedAt"] = now_iso()

def task_has_prior_required_rework_verdict(task: Dict[str, Any]) -> bool:
    for gate in task_quality_gates(task):
        if gate.get("required") is False or gate.get("status") == "skipped":
            continue
        if gate.get("status") in {"changes_requested", "blocked"}:
            return True
        for attempt in gate_attempts(gate):
            if not isinstance(attempt, dict):
                continue
            if attempt.get("completedAt") and attempt.get("status") in {"changes_requested", "blocked", "failed"}:
                return True
    return False

def feedback_comment_type_for_gate(gate: Dict[str, Any]) -> str:
    role = str(gate.get("role") or "")
    if role == "tester":
        return "test_feedback"
    if role == "product":
        return "product_feedback"
    if role == "architect":
        return "architect_feedback"
    return "review_feedback"

def next_publish_status(task: Dict[str, Any]) -> str:
    gates = task_quality_gates(task)
    for phase in gate_phase_order():
        if any(
            gate.get("phase") == phase
            and gate.get("required") is not False
            and gate.get("status") in {"pending", "changes_requested", "blocked"}
            for gate in gates
        ):
            return phase
    return "done"

def phase_has_open_required_gates(task: Dict[str, Any], phase: str) -> bool:
    for gate in task_quality_gates(task):
        if gate.get("phase") != phase or gate.get("required") is False:
            continue
        if gate.get("status") not in {"approved", "skipped"}:
            return True
    return False

def task_has_required_gate_status(task: Dict[str, Any], statuses: set[str]) -> bool:
    return any(
        gate.get("required") is not False and gate.get("status") in statuses
        for gate in task_quality_gates(task)
    )

def open_required_quality_gates(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        gate for gate in task_quality_gates(task)
        if gate.get("required") is not False and gate.get("status") not in {"approved", "skipped"}
    ]

def task_status_done_requires_closed_gates(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    del state
    return bool(open_required_quality_gates(task))

def sync_product_quality_gate(task: Dict[str, Any], state: Dict[str, Any], policy: Dict[str, Any]) -> None:
    gates = task.setdefault("qualityGates", [])
    if not isinstance(gates, list):
        gates = []
        task["qualityGates"] = gates

    existing_index = next(
        (
            index
            for index, gate in enumerate(gates)
            if isinstance(gate, dict) and gate.get("id") == "product"
        ),
        None,
    )

    if not task.get("productFacing"):
        if existing_index is not None:
            gates.pop(existing_index)
        return

    gate_specs = policy.get("gates") if isinstance(policy.get("gates"), dict) else {}
    spec = gate_specs.get("product")
    if not isinstance(spec, dict):
        return
    role = str(spec.get("role") or "product")
    if folder_store.roster_is_configured_in_state(state) and role not in folder_store.roster_roles_from_state(state):
        return
    if role == task.get("role"):
        return

    if existing_index is None:
        gates.append({
            "id": "product",
            "phase": spec["phase"],
            "role": role,
            "status": "pending",
            "required": bool(spec.get("required", True)),
            "allowSelfReview": True,
            "focus": str(spec.get("focus") or ""),
            "attempts": [],
        })
        return

    gate = gates[existing_index]
    if isinstance(gate, dict):
        gate["phase"] = spec["phase"]
        gate["role"] = role
        gate["required"] = bool(spec.get("required", True))
        gate.setdefault("status", "pending")
        gate.setdefault("allowSelfReview", True)
        gate.setdefault("attempts", [])
        gate["focus"] = str(spec.get("focus") or gate.get("focus") or "")

def next_status_after_gate_verdict(task: Dict[str, Any], phase: str) -> str:
    if phase_has_open_required_gates(task, phase):
        return phase
    return next_publish_status(task)

def current_gate_attempt(gate: Dict[str, Any], actor: str) -> Dict[str, Any]:
    for attempt in reversed(gate_attempts(gate)):
        if isinstance(attempt, dict) and attempt.get("status") == "in_progress" and attempt.get("claimedBy") == actor:
            return attempt
    raise SystemExit(
        "No active gate attempt is claimed by this agent. "
        "If you are reporting rework outside an active gate, use sprintengine.task.request_changes. "
        "Use sprintengine.task.status only for explicit repair/admin transitions."
    )

def complete_gate_attempt(attempt: Dict[str, Any], verdict: str, summary: str) -> None:
    attempt["status"] = verdict
    attempt["verdict"] = verdict
    attempt["completedAt"] = now_iso()
    attempt["summary"] = summary

def set_gate_agent_idle(state: Dict[str, Any], actor: str, role: str) -> None:
    agent = ensure_agent(state, actor, role)
    set_agent_idle(agent)

def next_recorded_artifact_id(state: Dict[str, Any]) -> str:
    from sprintengine_core.tool.artifacts import next_artifact_id

    return next_artifact_id(state.setdefault("artifacts", []))

def recorded_artifact_kind_for_gate(gate: Dict[str, Any]) -> str:
    role = str(gate.get("role") or "")
    if role == "tester":
        return "validation_report"
    if role == "spec_reviewer":
        return "spec_review"
    if role == "performance":
        return "performance_review"
    if role == "production_readiness_reviewer":
        return "production_readiness_review"
    if role == "cross_platform":
        return "cross_platform_review"
    if role == "security":
        return "security_review"
    if role == "product":
        return "product_strategy"
    return "code_review"

def create_recorded_gate_artifact(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    gate: Dict[str, Any],
    actor: str,
    *,
    path: str,
    title: str,
    kind: Optional[str] = None,
) -> Dict[str, Any]:
    from sprintengine_core.tool.artifacts import file_fingerprint, normalize_artifact_path

    path_info = normalize_artifact_path(state_path, path, require_file=True)
    now = now_iso()
    artifact = {
        "id": next_recorded_artifact_id(state),
        "kind": kind or recorded_artifact_kind_for_gate(gate),
        "title": title.strip() or f"{gate.get('role')} gate evidence",
        "path": path_info["path"],
        "status": "recorded",
        "createdBy": actor,
        "taskId": task.get("id"),
        "fingerprint": file_fingerprint(path_info["absolutePath"]),
        "reviewHistory": [{"action": "recorded", "actor": actor, "timestamp": now}],
        "recommendedTasks": [],
        "createdAt": now,
        "updatedAt": now,
        "gateId": gate.get("id"),
    }
    state.setdefault("artifacts", []).append(artifact)
    return artifact

def apply_gate_verdict(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    gate: Dict[str, Any],
    actor: str,
    verdict: str,
    summary: str,
    *,
    required_actions: Optional[List[str]] = None,
    needs_input: Optional[Dict[str, str]] = None,
    artifact_path: Optional[str] = None,
    artifact_title: Optional[str] = None,
    artifact_kind: Optional[str] = None,
) -> Dict[str, Any]:
    if verdict not in VALID_GATE_VERDICTS:
        raise SystemExit(f"Invalid gate verdict {verdict!r}.")
    clean_summary = str(summary or "").strip()
    if not clean_summary:
        raise SystemExit("--summary is required for gate verdicts.")
    role = str(gate.get("role") or "")
    attempt = current_gate_attempt(gate, actor)
    complete_gate_attempt(attempt, verdict, clean_summary)
    artifact = None
    if artifact_path:
        artifact = create_recorded_gate_artifact(
            state,
            state_path,
            task,
            gate,
            actor,
            path=artifact_path,
            title=artifact_title or f"{gate.get('id')} evidence",
            kind=artifact_kind,
        )
        attempt["artifactId"] = artifact["id"]

    phase = str(gate.get("phase") or "")
    if verdict in {"approved", "skipped"}:
        gate["status"] = "approved" if verdict == "approved" else "skipped"
        if verdict == "skipped":
            gate["skipRationale"] = clean_summary
        if task_has_required_gate_status(task, {"blocked"}):
            next_status = "needs_input"
        elif task_has_required_gate_status(task, {"changes_requested"}):
            next_status = "changes_requested"
        else:
            next_status = next_status_after_gate_verdict(task, phase)
        task["status"] = next_status
        if next_status in {"review", "testing", "product", "changes_requested", "done"}:
            task["ownerAgentId"] = None
        if next_status == "done":
            task["completedAt"] = now_iso()
        else:
            task["completedAt"] = None
        task.pop("needsInput", None)
        comment = None
    elif verdict in {"changes_requested", "failed"}:
        gate["status"] = "changes_requested"
        actions = [str(action).strip() for action in (required_actions or []) if str(action).strip()]
        attempt["requiredActions"] = actions
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=clean_summary,
            comment_type=feedback_comment_type_for_gate(gate),
            source="agent",
            data={
                "status": "open",
                "verdict": verdict,
                "gateId": gate.get("id"),
                "requiredActions": actions,
                "artifactId": artifact.get("id") if artifact else None,
            },
        )
        task["status"] = "changes_requested"
        task["ownerAgentId"] = None
        task["completedAt"] = None
        task.pop("needsInput", None)
        next_status = "changes_requested"
    else:
        if not needs_input or not needs_input.get("question"):
            raise SystemExit("Blocked gate verdicts require --needs-input-question.")
        gate["status"] = "blocked"
        task["status"] = "needs_input"
        task["completedAt"] = None
        task["needsInput"] = {
            "kind": needs_input.get("kind") or "architect",
            "reason": needs_input.get("reason") or "blocked_other",
            "question": needs_input["question"],
            "reportedBy": actor,
            "reportedAt": now_iso(),
        }
        if needs_input.get("suggestedResolution"):
            task["needsInput"]["suggestedResolution"] = needs_input["suggestedResolution"]
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=clean_summary,
            comment_type="needs_input",
            source="agent",
            data={"gateId": gate.get("id"), "verdict": verdict, "artifactId": artifact.get("id") if artifact else None},
        )
        next_status = "needs_input"
    set_gate_agent_idle(state, actor, role)
    append_task_activity(
        task,
        "gate_verdict",
        actor,
        f"{actor} submitted {verdict} for gate {gate.get('id')} on {task.get('id')}.",
        {"gateId": gate.get("id"), "verdict": verdict, "status": task.get("status"), "artifactId": artifact.get("id") if artifact else None},
    )
    return {"attempt": attempt, "comment": comment, "artifact": artifact, "nextStatus": next_status}
