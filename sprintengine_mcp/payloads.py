"""Payload adapters for command-backed Sprint Engine MCP tools."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sprintengine_core.tool.constants import FEEDBACK_COUNT_FIELDS, FEEDBACK_SCORE_FIELDS, FEEDBACK_TEXT_FIELDS

from .auth import ActorContext


def command_payload_to_namespace(
    tool_name: str,
    state_path: Path,
    payload: dict[str, Any],
    actor: ActorContext | None,
) -> SimpleNamespace:
    base: dict[str, Any] = {"state": state_path}
    if tool_name == "sprintengine.init":
        base.update(goal=payload.get("goal"), use_worktrees=bool(payload.get("useWorktrees", False)), agent=list(payload.get("agent") or []))
    elif tool_name == "sprintengine.handover":
        base.update(
            name=payload["name"],
            goal=payload.get("goal"),
            handover=payload.get("handoverPath"),
            handover_text=payload.get("handoverText"),
            handover_stdin=False,
            source=list(payload.get("source") or []),
            source_plan_kind=payload.get("sourcePlanKind") or "unknown",
            actor=payload.get("actor") or _actor_id(actor, "sprintengine"),
            force=bool(payload.get("force", False)),
        )
    elif tool_name == "sprintengine.join":
        base.update(role=payload["role"], id=payload["id"], watch=bool(payload.get("watch", False)), max_wait_seconds=payload.get("maxWaitSeconds"))
    elif tool_name == "sprintengine.agent.next_directive":
        base.update(role=payload["role"], id=payload["agentId"], attempts=payload.get("attempts") or 1)
    elif tool_name == "sprintengine.roster.add":
        base.update(role=payload["role"], id=payload["id"], actor=payload.get("actor") or _actor_id(actor, "architect"))
    elif tool_name == "sprintengine.roster.retire":
        base.update(id=payload["id"], reason=payload["reason"], actor=payload.get("actor") or _actor_id(actor, payload["id"]))
    elif tool_name == "sprintengine.roster.replenish":
        base.update(role=payload.get("role"), actor=payload.get("actor") or _actor_id(actor, "runner"))
    elif tool_name == "sprintengine.roster.list":
        pass
    elif tool_name == "sprintengine.triage.needs_input":
        base.update(id=payload["id"])
    elif tool_name == "sprintengine.task.next":
        base.update(role=payload["role"], id=payload["id"])
    elif tool_name == "sprintengine.task.claim":
        base.update(task_id=payload["taskId"], id=payload["id"])
    elif tool_name == "sprintengine.task.status":
        base.update(task_id=payload["taskId"], status=payload["status"], id=payload["id"], summary=payload.get("summary"))
        base.update(
            needs_input_kind=payload.get("needsInputKind"),
            needs_input_reason=payload.get("needsInputReason"),
            needs_input_artifact_id=payload.get("needsInputArtifactId"),
            needs_input_question=payload.get("needsInputQuestion"),
            needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
        )
        add_feedback_defaults(base, payload)
    elif tool_name == "sprintengine.task.resolve_input":
        base.update(task_id=payload["taskId"], id=payload["id"], resolution=payload["resolution"], complete=bool(payload.get("complete", False)))
    elif tool_name == "sprintengine.task.release":
        base.update(task_id=payload["taskId"], id=payload["id"], reason=payload["reason"])
    elif tool_name == "sprintengine.task.ready":
        base.update(task_id=payload["taskId"], id=payload["id"], triaged_by=payload.get("triagedBy") or "user")
    elif tool_name == "sprintengine.task.log":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            summary=payload.get("summary"),
            file=list(payload.get("file") or []),
            command=list(payload.get("command") or []),
            result=list(payload.get("result") or []),
            scope_expansion_json=list(payload.get("scopeExpansionJson") or payload.get("scopeExpansion") or []),
        )
    elif tool_name == "sprintengine.task.publish":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            summary=payload["summary"],
            path=list(payload.get("path") or payload.get("file") or []),
            summary_data_json=json.dumps(payload.get("data")) if isinstance(payload.get("data"), dict) else payload.get("summaryDataJson"),
        )
        add_implementer_difficulty_defaults(base, payload)
    elif tool_name == "sprintengine.task.note":
        base.update(task_id=payload["taskId"], id=payload["id"], note=payload["note"])
    elif tool_name == "sprintengine.task.comment":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            body=payload["body"],
            source=payload.get("source") or "user",
            comment_type=payload.get("commentType"),
            path=list(payload.get("paths") or payload.get("path") or []),
            data_json=json.dumps(payload.get("data")) if isinstance(payload.get("data"), dict) else payload.get("dataJson"),
        )
    elif tool_name == "sprintengine.task.comment.list":
        base.update(task_id=payload["taskId"])
    elif tool_name == "sprintengine.task.list":
        base["role"] = payload.get("role")
    elif tool_name == "sprintengine.gate.list":
        base.update(task_id=payload.get("taskId"), role=payload.get("role"))
    elif tool_name == "sprintengine.gate.next":
        base.update(role=payload["role"], id=payload["id"])
    elif tool_name == "sprintengine.gate.claim":
        base.update(task_id=payload["taskId"], gate_id=payload["gateId"], role=payload["role"], id=payload["id"])
    elif tool_name in {"sprintengine.gate.verdict", "sprintengine.gate.publish"}:
        base.update(
            task_id=payload["taskId"],
            gate_id=payload["gateId"],
            role=payload["role"],
            id=payload["id"],
            verdict=payload["verdict"],
            summary=payload["summary"],
            required_action=list(payload.get("requiredAction") or []),
            artifact_path=payload.get("artifactPath"),
            artifact_title=payload.get("artifactTitle"),
            artifact_kind=payload.get("artifactKind"),
            needs_input_kind=payload.get("needsInputKind"),
            needs_input_reason=payload.get("needsInputReason"),
            needs_input_question=payload.get("needsInputQuestion"),
            needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
        )
        add_reviewer_difficulty_defaults(base, payload)
        add_feedback_defaults(base, payload)
    elif tool_name == "sprintengine.plan.add_task":
        base.update(
            actor=payload.get("actor") or _actor_id(actor, "architect"),
            task_id=payload.get("taskId"),
            title=payload["title"],
            description=payload.get("description", ""),
            role=payload["role"],
            depends_on=list(payload.get("dependsOn") or []),
            path=list(payload.get("path") or []),
            acceptance=list(payload.get("acceptance") or []),
            note=list(payload.get("note") or []),
            task_note=list(payload.get("taskNote") or []),
            produces_implementation=bool(payload.get("producesImplementation", False)),
            needs_triage=bool(payload.get("needsTriage", False)),
            no_quality_gates=bool(payload.get("noQualityGates", False)),
            no_review=bool(payload.get("noReview", False)),
            no_testing=bool(payload.get("noTesting", False)),
            product_facing=bool(payload.get("productFacing", False)),
            not_product_facing=bool(payload.get("notProductFacing", False)),
            no_product_acceptance=bool(payload.get("noProductAcceptance", False)),
            require_gate=list(payload.get("requireGate") or []),
            skip_gate=list(payload.get("skipGate") or []),
            manual_dispatch=bool(payload.get("manualDispatch", False)),
            dispatch_status=payload.get("dispatchStatus") or "todo",
            triaged_by=payload.get("triagedBy") or "none",
        )
        add_architect_difficulty_defaults(base, payload)
    elif tool_name == "sprintengine.plan.update_task":
        base.update(
            actor=payload.get("actor") or _actor_id(actor, "architect"),
            task_id=payload["taskId"],
            title=payload.get("title"),
            description=payload.get("description"),
            clear_description=bool(payload.get("clearDescription", False)),
            role=payload.get("role"),
            path=payload.get("path"),
            clear_paths=bool(payload.get("clearPaths", False)),
            acceptance=payload.get("acceptance"),
            clear_acceptance=bool(payload.get("clearAcceptance", False)),
            note=payload.get("note"),
            clear_notes=bool(payload.get("clearNotes", False)),
            task_note=payload.get("taskNote"),
            clear_task_notes=bool(payload.get("clearTaskNotes", False)),
            produces_implementation=bool(payload.get("producesImplementation", False)),
            needs_triage=payload.get("needsTriage") if "needsTriage" in payload else None,
            clear_needs_triage=bool(payload.get("clearNeedsTriage", False)),
            no_quality_gates=bool(payload.get("noQualityGates", False)),
            no_review=bool(payload.get("noReview", False)),
            no_testing=bool(payload.get("noTesting", False)),
            product_facing=bool(payload.get("productFacing", False)),
            not_product_facing=bool(payload.get("notProductFacing", False)),
            no_product_acceptance=bool(payload.get("noProductAcceptance", False)),
            require_gate=list(payload.get("requireGate") or []),
            skip_gate=list(payload.get("skipGate") or []),
            force=bool(payload.get("force", False)),
        )
        add_architect_difficulty_defaults(base, payload)
    elif tool_name == "sprintengine.plan.delete_task":
        base.update(actor=payload.get("actor") or _actor_id(actor, "architect"), task_id=payload["taskId"], unlink_dependents=bool(payload.get("unlinkDependents", False)), force=bool(payload.get("force", False)))
    elif tool_name in {"sprintengine.plan.add_dependency", "sprintengine.plan.remove_dependency"}:
        base.update(actor=payload.get("actor") or _actor_id(actor, "architect"), task_id=payload["taskId"], depends_on=list(payload.get("dependsOn") or []), force=bool(payload.get("force", False)))
    elif tool_name == "sprintengine.plan.start_review":
        base.update(role=payload["role"], id=payload["id"])
    elif tool_name == "sprintengine.plan.address_reviews":
        base["actor"] = payload.get("actor") or _actor_id(actor, "architect")
    elif tool_name == "sprintengine.plan.list":
        pass
    elif tool_name == "sprintengine.artifact.add":
        base.update(actor=payload.get("actor") or _actor_id(actor, "agent"), artifact_id=payload.get("artifactId"), task_id=payload["taskId"], kind=payload["kind"], title=payload["title"], path=payload["path"], created_by=payload.get("createdBy"), recommended_task=list(payload.get("recommendedTask") or []), ready=bool(payload.get("ready", False)))
    elif tool_name == "sprintengine.artifact.list":
        base.update(task_id=payload.get("taskId"), kind=payload.get("kind"), status=payload.get("status"))
    elif tool_name == "sprintengine.artifact.ready":
        base.update(artifact_id=payload["artifactId"], id=payload["id"])
        add_feedback_defaults(base, payload)
    elif tool_name == "sprintengine.artifact.approve":
        base.update(artifact_id=payload["artifactId"], id=payload["id"])
    elif tool_name == "sprintengine.artifact.request_changes":
        base.update(artifact_id=payload["artifactId"], id=payload["id"], feedback=payload["feedback"])
    return SimpleNamespace(**base)


def add_feedback_defaults(target: dict[str, Any], payload: dict[str, Any]) -> None:
    for attr, camel, _ in FEEDBACK_SCORE_FIELDS:
        target[attr] = payload.get(attr, payload.get(camel))
    for attr, camel, _ in FEEDBACK_COUNT_FIELDS:
        target[attr] = payload.get(attr, payload.get(camel))
    for attr, camel, _ in FEEDBACK_TEXT_FIELDS:
        target[attr] = payload.get(camel, payload.get(attr, ""))
    target["issue_json"] = _json_list(payload.get("issueJson", payload.get("issue_json", [])))
    target["finding_json"] = _json_list(payload.get("findingJson", payload.get("finding_json", [])))


def add_implementer_difficulty_defaults(target: dict[str, Any], payload: dict[str, Any]) -> None:
    target["actual_difficulty_pct"] = payload.get("actual_difficulty_pct", payload.get("actualDifficultyPct"))
    target["actual_difficulty_reason"] = payload.get("actualDifficultyReason", payload.get("actual_difficulty_reason", ""))


def add_architect_difficulty_defaults(target: dict[str, Any], payload: dict[str, Any]) -> None:
    target["difficulty_pct"] = payload.get("difficulty_pct", payload.get("difficultyPct"))
    target["difficulty_reason"] = payload.get("difficultyReason", payload.get("difficulty_reason", ""))


def add_reviewer_difficulty_defaults(target: dict[str, Any], payload: dict[str, Any]) -> None:
    target["reviewed_difficulty_pct"] = payload.get("reviewed_difficulty_pct", payload.get("reviewedDifficultyPct"))
    target["reviewed_difficulty_dimension"] = payload.get("reviewedDifficultyDimension", payload.get("reviewed_difficulty_dimension", ""))
    target["reviewed_difficulty_reason"] = payload.get("reviewedDifficultyReason", payload.get("reviewed_difficulty_reason", ""))


def _json_list(values: Any) -> list[str]:
    return [value if isinstance(value, str) else json.dumps(value) for value in values or []]


def _actor_id(actor: ActorContext | None, default: str) -> str:
    return actor.id if actor else default
