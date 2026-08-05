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
        base.update(goal=payload.get("goal"), use_worktrees=bool(payload.get("useWorktrees", False)), agent=_string_list(payload.get("agent")))
    elif tool_name == "sprintengine.handover":
        base.update(
            name=payload["name"],
            goal=payload.get("goal"),
            handover=payload.get("handoverPath"),
            handover_text=payload.get("handoverText"),
            handover_stdin=False,
            source=_string_list(payload.get("source")),
            source_plan_kind=payload.get("sourcePlanKind") or "unknown",
            reference=bool(payload.get("reference", False)),
            actor=payload.get("actor") or _actor_id(actor, "sprintengine"),
            force=bool(payload.get("force", False)),
        )
    elif tool_name == "sprintengine.join":
        base.update(role=payload.get("role"), id=payload["id"])
    elif tool_name == "sprintengine.triage.needs_input":
        base.update(id=payload["id"])
    elif tool_name == "sprintengine.task.next":
        base.update(role=payload.get("role"), id=payload["id"], repo=payload.get("repo"))
    elif tool_name == "sprintengine.task.claim":
        base.update(task_id=payload["taskId"], id=payload["id"])
    elif tool_name == "sprintengine.task.status":
        base.update(task_id=payload["taskId"], status=payload["status"], id=payload["id"], summary=payload.get("summary"))
        # `actorKind` is deliberately NOT advertised in the tool schema: only the
        # Multicode supervisor passes `human`, to carry the Inbox send-back
        # through the engine's done-terminal guard. Agent callers default to
        # `agent` and cannot reopen terminal tasks.
        base.update(actor_kind="human" if payload.get("actorKind") == "human" else "agent")
        base.update(
            needs_input_kind=payload.get("needsInputKind"),
            needs_input_reason=payload.get("needsInputReason"),
            needs_input_artifact_id=payload.get("needsInputArtifactId"),
            needs_input_finding_id=payload.get("needsInputFindingId"),
            needs_input_question=payload.get("needsInputQuestion"),
            needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
        )
        add_feedback_defaults(base, payload)
    elif tool_name == "sprintengine.task.resolve_input":
        base.update(task_id=payload["taskId"], id=payload["id"], resolution=payload["resolution"], complete=bool(payload.get("complete", False)))
    elif tool_name == "sprintengine.task.release":
        base.update(task_id=payload["taskId"], id=payload["id"], reason=payload["reason"])
    elif tool_name == "sprintengine.task.log":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            summary=payload.get("summary"),
            file=_string_list(payload.get("file")),
            command=_string_list(payload.get("command")),
            result=_string_list(payload.get("result")),
            scope_expansion_json=_string_list(payload.get("scopeExpansionJson") or payload.get("scopeExpansion")),
        )
        add_feedback_defaults(base, payload)
    elif tool_name == "sprintengine.task.publish":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            summary=payload["summary"],
            path=_string_list(payload.get("path") or payload.get("file")),
            changed_path=_string_list(payload.get("changedPath")),
            summary_data_json=json.dumps(payload.get("data")) if isinstance(payload.get("data"), dict) else payload.get("summaryDataJson"),
            no_changes_ok=bool(payload.get("noChangesOk", False)),
        )
        add_implementer_difficulty_defaults(base, payload)
    elif tool_name == "sprintengine.task.advance":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            phase=payload["phase"],
            outcome=payload["outcome"],
            summary=payload["summary"],
            needs_input_kind=payload.get("needsInputKind"),
            needs_input_reason=payload.get("needsInputReason"),
            needs_input_finding_id=payload.get("needsInputFindingId"),
            needs_input_question=payload.get("needsInputQuestion"),
            needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
        )
        add_feedback_defaults(base, payload)
    elif tool_name == "sprintengine.task.note":
        base.update(task_id=payload["taskId"], id=payload["id"], note=payload["note"])
    elif tool_name == "sprintengine.task.comment":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            body=payload["body"],
            source=payload.get("source") or "user",
            comment_type=payload.get("commentType"),
            path=_string_list(payload.get("paths") or payload.get("path")),
            data_json=json.dumps(payload.get("data")) if isinstance(payload.get("data"), dict) else payload.get("dataJson"),
        )
    elif tool_name == "sprintengine.task.comment.list":
        base.update(task_id=payload["taskId"])
    elif tool_name == "sprintengine.task.list":
        base["role"] = payload.get("role")
    elif tool_name == "sprintengine.plan.add_task":
        base.update(
            actor=payload.get("actor") or _actor_id(actor, "architect"),
            task_id=payload.get("taskId"),
            title=payload["title"],
            description=payload.get("description", ""),
            role=payload.get("role"),
            depends_on=_string_list(payload.get("dependsOn")),
            path=_string_list(payload.get("path")),
            acceptance=_string_list(payload.get("acceptance")),
            note=_string_list(payload.get("note")),
            source_doc=_string_list(payload.get("sourceDocs")),
            **_backlog_ref_fields(payload.get("backlogRef")),
            task_note=_string_list(payload.get("taskNote")),
            produces_implementation=bool(payload.get("producesImplementation", False)),
            kind=payload.get("kind"),
            **_from_finding_fields(payload.get("fromFinding")),
            needs_triage=bool(payload.get("needsTriage", False)),
            # `[]` is an explicit "no phases", so presence — not truthiness — decides
            # whether the task overrides the run default.
            phases=payload["phases"] if "phases" in payload else None,
            product_facing=bool(payload.get("productFacing", False)),
            not_product_facing=bool(payload.get("notProductFacing", False)),
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
            source_doc=payload.get("sourceDocs"),
            clear_source_docs=bool(payload.get("clearSourceDocs", False)),
            **_backlog_ref_fields(payload.get("backlogRef")),
            clear_backlog_ref=bool(payload.get("clearBacklogRef", False)),
            task_note=payload.get("taskNote"),
            clear_task_notes=bool(payload.get("clearTaskNotes", False)),
            produces_implementation=bool(payload.get("producesImplementation", False)),
            kind=payload.get("kind"),
            needs_triage=payload.get("needsTriage") if "needsTriage" in payload else None,
            phases=payload["phases"] if "phases" in payload else None,
            clear_needs_triage=bool(payload.get("clearNeedsTriage", False)),
            product_facing=bool(payload.get("productFacing", False)),
            not_product_facing=bool(payload.get("notProductFacing", False)),
            force=bool(payload.get("force", False)),
        )
        add_architect_difficulty_defaults(base, payload)
    elif tool_name == "sprintengine.plan.delete_task":
        base.update(actor=payload.get("actor") or _actor_id(actor, "architect"), task_id=payload["taskId"], unlink_dependents=bool(payload.get("unlinkDependents", False)), force=bool(payload.get("force", False)))
    elif tool_name in {"sprintengine.plan.add_dependency", "sprintengine.plan.remove_dependency"}:
        base.update(actor=payload.get("actor") or _actor_id(actor, "architect"), task_id=payload["taskId"], depends_on=_string_list(payload.get("dependsOn")), force=bool(payload.get("force", False)))
    elif tool_name == "sprintengine.plan.list":
        pass
    elif tool_name == "sprintengine.artifact.add":
        base.update(actor=payload.get("actor") or _actor_id(actor, "agent"), artifact_id=payload.get("artifactId"), task_id=payload["taskId"], kind=payload["kind"], title=payload["title"], path=payload["path"], created_by=payload.get("createdBy"), recommended_task=_string_list(payload.get("recommendedTask")), ready=bool(payload.get("ready", False)))
    elif tool_name == "sprintengine.artifact.list":
        base.update(task_id=payload.get("taskId"), kind=payload.get("kind"), status=payload.get("status"))
    elif tool_name == "sprintengine.artifact.ready":
        base.update(artifact_id=payload["artifactId"], id=payload["id"])
        add_feedback_defaults(base, payload)
    elif tool_name == "sprintengine.artifact.approve":
        base.update(artifact_id=payload["artifactId"], id=payload["id"], approval_mode=payload.get("approvalMode"))
    elif tool_name == "sprintengine.artifact.request_changes":
        base.update(artifact_id=payload["artifactId"], id=payload["id"], feedback=payload["feedback"])
    elif tool_name == "sprintengine.vcs.status":
        pass
    elif tool_name == "sprintengine.vcs.commit":
        base.update(
            task_id=payload["taskId"],
            id=payload["id"],
            summary=payload.get("summary"),
            path=_string_list(payload.get("path") or payload.get("paths")),
        )
    elif tool_name == "sprintengine.vcs.request_repo":
        base.update(root=payload["root"], repo_id=payload.get("repoId"), id=payload["id"])
    elif tool_name == "sprintengine.vcs.pr":
        base.update(
            id=payload.get("id") or _actor_id(actor, "architect"),
            base=payload.get("base"),
            title=payload.get("title"),
            body=payload.get("body"),
            draft=bool(payload.get("draft", False)),
            no_push=bool(payload.get("noPush", False)),
        )
    return SimpleNamespace(**base)


def add_feedback_defaults(target: dict[str, Any], payload: dict[str, Any]) -> None:
    for attr, camel, _ in FEEDBACK_SCORE_FIELDS:
        target[attr] = payload.get(attr, payload.get(camel))
    for attr, camel, _ in FEEDBACK_COUNT_FIELDS:
        target[attr] = payload.get(attr, payload.get(camel))
    for attr, camel, _ in FEEDBACK_TEXT_FIELDS:
        target[attr] = payload.get(camel, payload.get(attr, ""))
    # The reviewer-assessment trio: an agent assessing ANOTHER task passes all
    # three so the record attributes to the audited task's implementer.
    target["review_target_task_id"] = payload.get("reviewTargetTaskId", payload.get("review_target_task_id", ""))
    target["review_target_agent_id"] = payload.get("reviewTargetAgentId", payload.get("review_target_agent_id", ""))
    target["review_target_execution_id"] = payload.get("reviewTargetExecutionId", payload.get("review_target_execution_id", ""))
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


def _backlog_ref_fields(raw: Any) -> dict[str, Any]:
    """`backlogRef: {projectRelativePath, displayKey}` -> the CLI's two flat arguments."""
    if not isinstance(raw, dict):
        return {"backlog_ref": None, "backlog_key": None}
    return {
        "backlog_ref": raw.get("projectRelativePath"),
        "backlog_key": raw.get("displayKey"),
    }


def _from_finding_fields(raw: Any) -> dict[str, Any]:
    """`fromFinding: {taskId, findingId}` -> the CLI's two flat arguments."""
    if not isinstance(raw, dict):
        return {"from_finding_task_id": None, "from_finding_id": None}
    return {
        "from_finding_task_id": raw.get("taskId"),
        "from_finding_id": raw.get("findingId"),
    }


def _string_list(value: Any) -> list[str]:
    """Coerce a list-shaped payload field, WRAPPING a bare string.

    `list("ok - suite green")` is `["o","k"," ","-", ...]`. T15's evidence
    `results` array was char-by-char corrupted exactly this way — the audit
    trail of the audit task itself — because a client sent a string where the
    schema says array and `list()` spread it silently. Every list field here
    goes through this, so a bare string becomes a one-element list instead of
    shredding into characters, and a non-list scalar is wrapped rather than
    raising deep inside a command handler.
    """
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, (list, tuple)):
        return [item if isinstance(item, str) else json.dumps(item) for item in value]
    return [json.dumps(value)]


def _json_list(values: Any) -> list[str]:
    # Same bare-string hazard: a client sending one finding object (or one
    # pre-encoded finding string) rather than an array must not have it spread.
    if values is None:
        return []
    if isinstance(values, str):
        return [values] if values.strip() else []
    if isinstance(values, dict):
        return [json.dumps(values)]
    return [value if isinstance(value, str) else json.dumps(value) for value in values]


def _actor_id(actor: ActorContext | None, default: str) -> str:
    return actor.id if actor else default
