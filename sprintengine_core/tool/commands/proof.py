"""Integration proof command handlers (MC-1742)."""
from __future__ import annotations

import argparse
import json
from typing import Any, Dict

from sprintengine_core.tool.artifacts import (
    append_artifact_history,
    file_fingerprint,
    next_artifact_id,
    normalize_artifact_path,
)
from sprintengine_core.tool.integration_proof import (
    approve_human_proof,
    begin_integration_proof,
    complete_automated_proof,
    request_human_proof,
)
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.state import append_event, append_task_activity, find_task, with_locked_state
from sprintengine_core.tool.tasks import recompute_phase


def _read_proof_artifact(args: argparse.Namespace, state: Dict[str, Any], task: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    path_info = normalize_artifact_path(args.state, args.artifact_path, require_file=True)
    try:
        payload = json.loads(path_info["absolutePath"].read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Integration proof artifact is not valid JSON: {exc}") from exc
    artifact_id = str(getattr(args, "artifact_id", None) or "").strip() or next_artifact_id(state.setdefault("artifacts", []))
    if any(isinstance(artifact, dict) and artifact.get("id") == artifact_id for artifact in state.get("artifacts", [])):
        raise SystemExit(f"Artifact id already exists: {artifact_id}")
    now = now_iso()
    artifact = {
        "id": artifact_id,
        "kind": "integration_proof",
        "title": str(getattr(args, "title", None) or f"Integration proof {task.get('id')}").strip(),
        "path": path_info["path"],
        "status": "recorded",
        "createdBy": args.id,
        "taskId": task.get("id"),
        "fingerprint": file_fingerprint(path_info["absolutePath"]),
        "reviewHistory": [{"action": "recorded", "actor": args.id, "timestamp": now}],
        "recommendedTasks": [],
        "createdAt": now,
        "updatedAt": now,
    }
    return artifact, payload


def cmd_proof_begin(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        proof = begin_integration_proof(state, args.state, task, args.id)
        append_task_activity(task, "evidence", args.id, f"{args.id} began integration proof revision {proof['revision']}.")
        event = append_event(state, "integration_proof_begun", args.id, f"{args.id} began integration proof revision {proof['revision']}.", {"taskId": args.task_id, "revision": proof["revision"], "graphRevision": proof["graphRevision"], "repositoryHeads": proof.get("verifiedHeads", [])})
        return {"ok": True, "task": task, "integrationProof": proof, "event": event}

    return with_locked_state(args.state, run)


def cmd_proof_record(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        if str(task.get("ownerAgentId") or "") != str(args.id or ""):
            raise SystemExit("integration_proof_owner_required: only the proof task owner may record evidence.")
        artifact, payload = _read_proof_artifact(args, state, task)
        result = complete_automated_proof(state, args.state, task, artifact["id"], payload)
        state.setdefault("artifacts", []).append(artifact)
        append_task_activity(task, "artifact", args.id, f"{args.id} recorded valid integration proof {artifact['id']}.", {"artifactId": artifact["id"], "proofRevision": result["proof"]["revision"]})
        recompute_phase(state)
        event = append_event(state, "integration_proof_validated", args.id, f"Integration proof {artifact['id']} is valid.", {"taskId": args.task_id, "artifactId": artifact["id"], "revision": result["proof"]["revision"]})
        return {"ok": True, "task": task, "artifact": artifact, "integrationProof": result["proof"], "event": event}

    return with_locked_state(args.state, run)


def cmd_proof_request_human(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        if str(task.get("ownerAgentId") or "") != str(args.id or ""):
            raise SystemExit("integration_proof_owner_required: only the proof task owner may request human smoke.")
        artifact, payload = _read_proof_artifact(args, state, task)
        result = request_human_proof(state, args.state, task, artifact["id"], payload, args.blocker)
        artifact["status"] = "ready_for_review"
        artifact["reviewHistory"].append({"action": "ready_for_review", "actor": args.id, "timestamp": now_iso()})
        state.setdefault("artifacts", []).append(artifact)
        append_task_activity(task, "needs_input", args.id, f"{args.id} requested local-user smoke for proof {artifact['id']}.", {"artifactId": artifact["id"], "proofRevision": result["proof"]["revision"]})
        recompute_phase(state)
        event = append_event(state, "integration_proof_human_requested", args.id, f"Integration proof {artifact['id']} needs a local-user smoke.", {"taskId": args.task_id, "artifactId": artifact["id"], "revision": result["proof"]["revision"]})
        return {"ok": True, "task": task, "artifact": artifact, "integrationProof": result["proof"], "event": event}

    return with_locked_state(args.state, run)


def cmd_proof_approve_human(args: argparse.Namespace) -> Dict[str, Any]:
    """App-only managed-Python mutation; intentionally absent from MCP schemas."""
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        proof = approve_human_proof(state, args.state, task, args.artifact_id, "local_user")
        artifact = next(
            (candidate for candidate in state.get("artifacts", []) if isinstance(candidate, dict) and candidate.get("id") == args.artifact_id),
            None,
        )
        if not artifact or artifact.get("kind") != "integration_proof":
            raise SystemExit("integration_proof_artifact_not_found: local approval must name the recorded proof artifact.")
        artifact["status"] = "approved"
        artifact["approvedBy"] = "local_user"
        artifact["approvedAt"] = now_iso()
        artifact["approvalMode"] = "manual"
        append_artifact_history(artifact, "approved", "local_user", f"Human smoke approved for proof revision {proof['revision']}.")
        artifact["updatedAt"] = now_iso()
        append_task_activity(task, "artifact", "local_user", f"Local user approved human smoke {args.artifact_id}.", {"artifactId": args.artifact_id, "proofRevision": proof["revision"]})
        recompute_phase(state)
        event = append_event(state, "integration_proof_human_approved", "local_user", f"Local user approved integration proof {args.artifact_id}.", {"taskId": args.task_id, "artifactId": args.artifact_id, "revision": proof["revision"]})
        return {"ok": True, "task": task, "artifact": artifact, "integrationProof": proof, "event": event}

    return with_locked_state(args.state, run)


begin = cmd_proof_begin
record = cmd_proof_record
request_human = cmd_proof_request_human
approve_human = cmd_proof_approve_human
