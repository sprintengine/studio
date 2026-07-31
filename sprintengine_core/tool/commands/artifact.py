"""Sprint Engine artifact command handlers."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Dict

from sprintengine_core.tool.artifacts import (
    append_artifact_history,
    artifact_absolute_path,
    build_artifact_from_args,
    file_fingerprint,
    find_artifact,
    find_reusable_artifact,
    mark_task_done_if_artifacts_approved,
    mark_task_needs_input_for_artifact,
    normalize_artifact_path,
    reopen_task_for_artifact_changes,
    supersede_duplicate_artifacts,
)
from sprintengine_core.tool.constants import VALID_APPROVAL_MODES
from sprintengine_core.tool.feedback import append_feedback_record, attach_feedback_payload, build_feedback_payload
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.plans import actor_is_coordinator, epic_child_coverage_warnings
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
        candidate = build_artifact_from_args(args, state, args.state)
        # Reuse an existing non-superseded artifact for the same task + kind +
        # resolved file instead of registering a duplicate that would block
        # auto-approval (e.g. an init placeholder stored as the full plan path
        # plus a fresh bare-path registration that resolve to the same file).
        existing = find_reusable_artifact(
            state,
            args.state,
            str(candidate.get("taskId")),
            str(candidate.get("kind")),
            artifact_absolute_path(args.state, str(candidate.get("path"))),
        )
        reused = existing is not None
        if reused:
            artifact = existing
            artifact["title"] = candidate["title"]
            artifact["path"] = candidate["path"]
            artifact["fingerprint"] = candidate["fingerprint"]
            artifact["createdBy"] = candidate["createdBy"]
            artifact["updatedAt"] = candidate["updatedAt"]
            append_artifact_history(artifact, "registered", args.actor, "Reused existing same-file artifact; no duplicate created.")
            message = f"{args.actor} reused artifact {artifact['id']} for {artifact['taskId']} (duplicate registration deduplicated)."
        else:
            artifact = candidate
            state.setdefault("artifacts", []).append(artifact)
            message = f"{args.actor} registered artifact {artifact['id']} for {artifact['taskId']}."
        task = find_task(state, str(artifact.get("taskId")))
        append_task_activity(task, "artifact", args.actor, message, {"artifactId": artifact["id"], "artifactStatus": artifact["status"]})
        event = append_event(state, "artifact_added", args.actor, message)
        ready_result = None
        if args.ready:
            ready_result = set_artifact_ready(state, artifact, args.actor, args.state)
            append_event(state, "artifact_ready_for_review", args.actor, f"{args.actor} marked artifact {artifact['id']} ready for review.")
        recompute_phase(state)
        return {"ok": True, "artifact": artifact, "ready": ready_result, "event": event, "reused": reused}

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
    # Self-heal at the ready transition: clear stale non-approved same-file
    # duplicates before the auto-approval gate evaluates blocking siblings, so a
    # leftover draft placeholder cannot deadlock approval of this artifact.
    supersede_duplicate_artifacts(state, artifact, state_path, actor)
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

def normalize_approval_mode(raw: Any) -> str | None:
    # The CLI could enforce this via argparse choices, but the MCP server builds
    # the namespace directly and bypasses them, so validate here like
    # build_artifact_from_args does for artifact kind. Absent/blank means a
    # back-compatible approval that omits the field entirely.
    if raw is None:
        return None
    mode = str(raw).strip()
    if not mode:
        return None
    if mode not in VALID_APPROVAL_MODES:
        raise SystemExit(
            f"Invalid approvalMode: {mode}. Valid values: {', '.join(sorted(VALID_APPROVAL_MODES))}."
        )
    return mode

def cmd_artifact_approve(args: argparse.Namespace) -> Dict[str, Any]:
    approval_mode = normalize_approval_mode(getattr(args, "approval_mode", None))

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = find_artifact(state, args.artifact_id)
        if artifact.get("status") == "superseded":
            raise SystemExit("Superseded artifacts cannot be approved.")
        if artifact.get("status") == "draft":
            raise SystemExit("Draft artifacts must be marked ready before approval.")

        # Advisory only: the human approving an architect plan sees whether the
        # plan engages with the review expectation — review tasks planned at
        # all (MC-1818), a terminal integration_review covering the
        # implementation work, a `## Seams` section on a multi-task plan
        # (MC-1819) — plus each review task's acceptance criteria verbatim so
        # "this permits paper verification" is a call someone makes (MC-1820).
        #
        # None of it blocks, and none of it is a new approval requirement
        # (owner ruling 2026-07-23: autonomous means autonomous). Enforcement
        # depth is the run's EXISTING approval mode: in manual /
        # approved-artifacts modes the human reads these and judges the plan
        # like any artifact; under full auto-approval the planning directive is
        # the guidance and approval stands. A docs-only or spike plan may
        # legitimately carry none of it — the point is the absence is a visible
        # decision rather than an accident.
        integration_warnings: list[str] = []
        review_notices: list[dict] = []
        if artifact.get("kind") == "architect_plan":
            from sprintengine_core.tool.integration import (
                integration_review_warnings,
                review_acceptance_notices,
                review_planning_warnings,
            )
            from sprintengine_core.tool.seams import plan_seam_section_warnings
            integration_warnings = [
                *review_planning_warnings(state),
                *integration_review_warnings(state),
                # On an epic-sourced run the plan is a sequencing of the epic's
                # children, so "which child did this plan leave undelivered?" is
                # the same class of question as the review-coverage ones above,
                # and rides the same advisory channel (backlog item 2018).
                *epic_child_coverage_warnings(state),
                *plan_seam_section_warnings(
                    state, artifact_absolute_path(args.state, str(artifact.get("path") or ""))
                ),
            ]
            review_notices = review_acceptance_notices(state)

        task = find_task(state, str(artifact.get("taskId")))
        artifact["status"] = "approved"
        artifact["approvedBy"] = args.id
        artifact["approvedAt"] = now_iso()
        artifact["updatedAt"] = artifact["approvedAt"]
        if approval_mode is not None:
            artifact["approvalMode"] = approval_mode
        history_note = f"Approval mode: {approval_mode}." if approval_mode else None
        append_artifact_history(artifact, "approved", args.id, history_note)
        owner_id = str(task.get("ownerAgentId") or "").strip()
        superseded_artifact_ids = supersede_duplicate_artifacts(state, artifact, args.state, args.id)
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
            "supersededArtifactIds": superseded_artifact_ids,
            "event": event,
            "notification": notification,
            **({"integrationWarnings": integration_warnings} if integration_warnings else {}),
            **({"reviewAcceptance": review_notices} if review_notices else {}),
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
        # Planner feedback follows the run's coordinator seat, not the literal
        # architect — otherwise a run without one fell through to the generic
        # review_feedback bucket.
        comment_type = "architect_feedback" if actor_is_coordinator(state, args.id) else "review_feedback"
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
