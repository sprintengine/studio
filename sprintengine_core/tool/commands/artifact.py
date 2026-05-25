"""Sprint Engine artifact command handlers."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Dict

from sprintengine_core.tool.artifacts import (
    append_artifact_history,
    build_artifact_from_args,
    file_fingerprint,
    find_artifact,
    mark_task_done_if_artifacts_approved,
    mark_task_needs_input_for_artifact,
    normalize_artifact_path,
    reopen_task_for_artifact_changes,
)
from sprintengine_core.tool.feedback import append_feedback_record, attach_feedback_payload, build_feedback_payload
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.state import (
    append_agent_notification_event,
    append_event,
    append_task_activity,
    create_task_comment,
    find_task,
    with_locked_state,
)
from sprintengine_core.tool.tasks import recompute_phase

def cmd_artifact_add(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = build_artifact_from_args(args, state, args.state)
        state.setdefault("artifacts", []).append(artifact)
        task = find_task(state, str(artifact.get("taskId")))
        append_task_activity(task, "artifact", args.actor, f"{args.actor} registered artifact {artifact['id']}.", {"artifactId": artifact["id"], "artifactStatus": artifact["status"]})
        event = append_event(state, "artifact_added", args.actor, f"{args.actor} registered artifact {artifact['id']} for {artifact['taskId']}.")
        ready_result = None
        if args.ready:
            ready_result = set_artifact_ready(state, artifact, args.actor, args.state)
            append_event(state, "artifact_ready_for_review", args.actor, f"{args.actor} marked artifact {artifact['id']} ready for review.")
        recompute_phase(state)
        return {"ok": True, "artifact": artifact, "ready": ready_result, "event": event}

    return with_locked_state(args.state, run)

def cmd_artifact_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifacts = []
        for artifact in state.get("artifacts", []):
            if not isinstance(artifact, dict):
                continue
            if args.task_id and artifact.get("taskId") != args.task_id:
                continue
            if args.kind and artifact.get("kind") != args.kind:
                continue
            if args.status and artifact.get("status") != args.status:
                continue
            artifacts.append(artifact)
        return {"ok": True, "artifacts": artifacts, "write": False}

    return with_locked_state(args.state, run)


def set_artifact_ready(
    state: Dict[str, Any],
    artifact: Dict[str, Any],
    actor: str,
    state_path: Path,
) -> Dict[str, Any]:
    if artifact.get("status") == "superseded":
        raise SystemExit("Superseded artifacts cannot be marked ready for review.")
    if artifact.get("status") == "approved":
        raise SystemExit("Approved artifacts cannot be marked ready for review.")

    task = find_task(state, str(artifact.get("taskId")))
    owner_id = str(task.get("ownerAgentId") or "").strip()
    task_role = str(task.get("role") or "").strip()
    created_by = str(artifact.get("createdBy") or "").strip()
    if owner_id and (not created_by or created_by in {task_role, "sprintengine"}):
        artifact["createdBy"] = owner_id
    path_info = normalize_artifact_path(state_path, str(artifact.get("path", "")), require_file=True)
    artifact["path"] = path_info["path"]
    artifact["fingerprint"] = file_fingerprint(path_info["absolutePath"])
    artifact["status"] = "ready_for_review"
    artifact["updatedAt"] = now_iso()
    artifact.pop("approvedBy", None)
    artifact.pop("approvedAt", None)
    artifact.pop("changesRequestedBy", None)
    artifact.pop("changesRequestedAt", None)
    append_artifact_history(artifact, "ready_for_review", actor)
    mark_task_needs_input_for_artifact(state, task, artifact)
    append_task_activity(task, "artifact", actor, f"{actor} marked artifact {artifact.get('id')} ready for review.", {"artifactId": artifact.get("id"), "artifactStatus": artifact.get("status")})
    return {"taskId": task.get("id"), "taskStatus": task.get("status"), "artifactStatus": artifact.get("status")}

def cmd_artifact_ready(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = find_artifact(state, args.artifact_id)
        ready_result = set_artifact_ready(state, artifact, args.id, args.state)
        task = find_task(state, str(artifact.get("taskId")))
        feedback_payload = build_feedback_payload(args, state, args.state, task, args.id)
        if feedback_payload:
            attach_feedback_payload(state, feedback_payload, args.id)
        recompute_phase(state)
        event = append_event(state, "artifact_ready_for_review", args.id, f"{args.id} marked artifact {args.artifact_id} ready for review.")
        return {
            "ok": True,
            "artifact": artifact,
            "transition": ready_result,
            "event": event,
            "_feedbackRecord": feedback_payload["record"] if feedback_payload else None,
        }

    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_feedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result

def cmd_artifact_approve(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = find_artifact(state, args.artifact_id)
        if artifact.get("status") == "superseded":
            raise SystemExit("Superseded artifacts cannot be approved.")
        if artifact.get("status") == "draft":
            raise SystemExit("Draft artifacts must be marked ready before approval.")

        task = find_task(state, str(artifact.get("taskId")))
        artifact["status"] = "approved"
        artifact["approvedBy"] = args.id
        artifact["approvedAt"] = now_iso()
        artifact["updatedAt"] = artifact["approvedAt"]
        append_artifact_history(artifact, "approved", args.id)
        owner_id = str(task.get("ownerAgentId") or "").strip()
        task_completed = mark_task_done_if_artifacts_approved(state, task)
        append_task_activity(task, "artifact", args.id, f"{args.id} approved artifact {args.artifact_id}.", {"artifactId": args.artifact_id, "artifactStatus": "approved"})
        recompute_phase(state)
        event = append_event(state, "artifact_approved", args.id, f"{args.id} approved artifact {args.artifact_id}.")
        notification = None
        if task_completed:
            notification = append_agent_notification_event(
                state,
                args.id,
                owner_id,
                str(task.get("id") or ""),
                "task_completed_after_artifact_approval",
                f"Artifact {args.artifact_id} was approved by {args.id}. Your task {task.get('id')} is complete. Stop now.",
                args.artifact_id,
            )
        return {
            "ok": True,
            "artifact": artifact,
            "task": task,
            "taskCompleted": task_completed,
            "event": event,
            "notification": notification,
        }

    return with_locked_state(args.state, run)

def cmd_artifact_request_changes(args: argparse.Namespace) -> Dict[str, Any]:
    feedback = args.feedback.strip()
    if not feedback:
        raise SystemExit("Change request feedback cannot be empty.")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = find_artifact(state, args.artifact_id)
        if artifact.get("status") == "superseded":
            raise SystemExit("Superseded artifacts cannot receive change requests.")

        task = find_task(state, str(artifact.get("taskId")))
        artifact["status"] = "changes_requested"
        artifact["changesRequestedBy"] = args.id
        artifact["changesRequestedAt"] = now_iso()
        artifact["updatedAt"] = artifact["changesRequestedAt"]
        artifact.pop("approvedBy", None)
        artifact.pop("approvedAt", None)
        append_artifact_history(artifact, "changes_requested", args.id, feedback)

        # Feedback flows through the comments stream so the body, author, and
        # timestamp surface in the activity feed and enter open_feedback /
        # open_rework comment queues. The artifact-state activity entry above
        # carries the verb; this comment carries the human prose.
        actor_role = str(state.get("agents", {}).get(args.id, {}).get("role") or "").strip().lower()
        if actor_role == "architect":
            comment_type = "architect_feedback"
        elif actor_role == "tester":
            comment_type = "test_feedback"
        elif actor_role == "product":
            comment_type = "product_feedback"
        else:
            comment_type = "review_feedback"
        artifact_id = str(artifact.get("id") or "")
        artifact_title = str(artifact.get("title") or "")
        comment_body = f"Changes requested for artifact {artifact_id} ({artifact_title}): {feedback}"
        create_task_comment(
            state,
            task,
            actor=args.id,
            body=comment_body,
            comment_type=comment_type,
            data={"artifactId": artifact_id, "artifactStatus": "changes_requested"},
        )
        owner_id = str(task.get("ownerAgentId") or "").strip()
        reopened_status = reopen_task_for_artifact_changes(state, task)
        append_task_activity(task, "artifact", args.id, f"{args.id} requested changes for artifact {args.artifact_id}.", {"artifactId": args.artifact_id, "artifactStatus": "changes_requested", "status": reopened_status})
        recompute_phase(state)
        event = append_event(state, "artifact_changes_requested", args.id, f"{args.id} requested changes for artifact {args.artifact_id}.")
        notification = append_agent_notification_event(
            state,
            args.id,
            owner_id,
            str(task.get("id") or ""),
            "task_changes_requested_after_artifact_review",
            f"Changes were requested for artifact {args.artifact_id} by {args.id}. Re-read the task feedback comments and revise if you still own the task.",
            args.artifact_id,
        )
        return {
            "ok": True,
            "artifact": artifact,
            "task": task,
            "reopenedStatus": reopened_status,
            "event": event,
            "notification": notification,
        }

    return with_locked_state(args.state, run)

add = cmd_artifact_add
list_artifacts = cmd_artifact_list
ready = cmd_artifact_ready
approve = cmd_artifact_approve
request_changes = cmd_artifact_request_changes
