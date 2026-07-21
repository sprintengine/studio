"""MC-1742 structural seam manifest and freshness-bound proof gate."""
from __future__ import annotations

import json
import subprocess

import pytest

from helpers import create_workspace_team, get_task, read_state, task, write_state
from sprintengine_core.tool.integration_proof import run_is_complete, validate_integration_plan


def _git(workspace, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=workspace,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return completed.stdout.strip()


def _repo(fixture) -> None:
    workspace = fixture.cli.cwd
    _git(workspace, "init", "-q")
    _git(workspace, "config", "user.email", "proof@example.test")
    _git(workspace, "config", "user.name", "Proof Test")
    marker = workspace / "product.txt"
    marker.write_text("connected\n", encoding="utf-8")
    _git(workspace, "add", "product.txt")
    _git(workspace, "commit", "-qm", "seed")


def _required_state(fixture) -> dict:
    state = read_state(fixture.state_path)
    work = get_task(state, "T1")
    work.update({
        "status": "done",
        "completedAt": "2026-07-21T00:00:00Z",
        "producesImplementation": True,
        "producesSeamIds": [],
        "consumesSeamIds": [],
    })
    proof_task = get_task(state, "P1")
    proof_task.update({
        "kind": "integration_proof",
        "status": "in_progress",
        "ownerAgentId": "tester-1",
        "ownedPaths": [],
        "phases": [],
    })
    state["integrationProof"] = {
        "required": True,
        "taskId": "P1",
        "mode": "engine_smoke",
        "status": "pending",
        "revision": 0,
        "graphRevision": 0,
    }
    state["integrationSeams"] = []
    write_state(fixture.state_path, state)
    return read_state(fixture.state_path)


def test_old_run_remains_proof_exempt() -> None:
    state = {"tasks": [{"status": "done"}]}
    assert run_is_complete(state) is True


def test_plan_validation_rejects_code_without_explicit_seam_arrays(tmp_path) -> None:
    fixture = create_workspace_team(tmp_path, "workspace", "structural", [
        task("T1", "Implement", "developer"),
        task("P1", "Prove", "tester"),
    ])
    state = read_state(fixture.state_path)
    get_task(state, "T1")["producesImplementation"] = True
    get_task(state, "P1").update({"kind": "integration_proof", "ownedPaths": [], "phases": []})
    state["integrationProof"] = {
        "required": True,
        "taskId": "P1",
        "mode": "engine_smoke",
        "status": "pending",
        "revision": 0,
        "graphRevision": 0,
    }
    state["integrationSeams"] = []

    with pytest.raises(SystemExit, match="integration_seam_declaration_required"):
        validate_integration_plan(state, fixture.state_path)

    get_task(state, "T1")["producesSeamIds"] = []
    get_task(state, "T1")["consumesSeamIds"] = []
    assert validate_integration_plan(state, fixture.state_path) == []
    get_task(state, "T1")["producesSeamIds"] = ["missing-seam"]
    with pytest.raises(SystemExit, match="integration_seam_unknown_declaration"):
        validate_integration_plan(state, fixture.state_path)
    get_task(state, "T1")["producesSeamIds"] = []
    state["integrationSeams"] = [{"id": "malformed"}]
    with pytest.raises(SystemExit, match="integration_seam_manifest_invalid"):
        validate_integration_plan(state, fixture.state_path)
    state["integrationSeams"] = []
    get_task(state, "P1")["status"] = "done"
    state["integrationProof"].update({"status": "valid", "artifactId": "A-old"})
    write_state(fixture.state_path, state)
    fixture.cli.run(
        "plan", "set-proof", "--required", "--task-id", "P1", "--mode", "engine_smoke",
    )
    reset = read_state(fixture.state_path)
    assert reset["integrationProof"]["status"] == "pending"
    assert get_task(reset, "P1")["status"] == "todo"
    exemption = fixture.cli.run_failure(
        "plan", "set-proof", "--exempt", "--rationale", "Attempted late exemption",
    )
    assert "integration_proof_required_for_code" in exemption.stderr


def test_real_engine_smoke_proof_completes_then_head_change_invalidates(tmp_path) -> None:
    fixture = create_workspace_team(tmp_path, "workspace", "proof", [
        task("T1", "Implement", "developer"),
        task("P1", "Prove", "tester", depends_on=["T1"]),
    ])
    _repo(fixture)
    _required_state(fixture)

    begun = fixture.cli.run("proof", "begin", "--task-id", "P1", "--id", "tester-1")
    proof = begun["integrationProof"]
    evidence = fixture.team_dir / "artifacts" / "engine-state.json"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text("real CLI smoke passed\n", encoding="utf-8")
    artifact = fixture.team_dir / "artifacts" / "integration-proof.json"
    artifact.write_text(json.dumps({
        "runId": fixture.team_dir.name,
        "proofRevision": proof["revision"],
        "mode": "engine_smoke",
        "graphRevision": proof["graphRevision"],
        "repositoryHeads": proof["verifiedHeads"],
        "coveredTaskIds": ["T1"],
        "coveredSeamIds": [],
        "scenarios": [{
            "id": "real-cli",
            "action": "Run the installed Sprint Engine CLI against the disposable folder store.",
            "expected": "The full command path completes successfully.",
            "outcome": "passed",
            "evidencePaths": ["artifacts/engine-state.json"],
        }],
        "commands": [{"cwdRepo": "primary", "command": "sprintengine proof record", "exitCode": 0}],
        "gateResults": [{"name": "engine-smoke", "outcome": "passed"}],
    }), encoding="utf-8")

    fixture.cli.run(
        "proof", "record", "--task-id", "P1", "--id", "tester-1",
        "--artifact-path", str(artifact.relative_to(fixture.cli.cwd)),
    )
    valid = read_state(fixture.state_path)
    assert valid["integrationProof"]["status"] == "valid"
    assert get_task(valid, "P1")["status"] == "done"
    assert run_is_complete(valid) is True
    get_task(valid, "P1")["status"] = "canceled"
    assert run_is_complete(valid) is False, "canceling the canonical proof task cannot preserve completion"
    get_task(valid, "P1")["status"] = "done"

    (fixture.cli.cwd / "product.txt").write_text("changed after proof\n", encoding="utf-8")
    _git(fixture.cli.cwd, "add", "product.txt")
    _git(fixture.cli.cwd, "commit", "-qm", "change after proof")
    fixture.cli.run("summary")
    invalidated = read_state(fixture.state_path)
    assert invalidated["integrationProof"]["status"] == "invalidated"
    assert get_task(invalidated, "P1")["status"] == "todo"
    assert invalidated["sprintengine"]["status"] != "completed"
    assert run_is_complete(invalidated) is False


def test_ordinary_completion_routes_cannot_bypass_proof(tmp_path) -> None:
    fixture = create_workspace_team(tmp_path, "workspace", "bypasses", [
        task("T1", "Implement", "developer"),
        task("P1", "Prove", "tester", status="needs_input", owner="tester-1"),
    ])
    _repo(fixture)
    state = _required_state(fixture)
    proof_task = get_task(state, "P1")
    proof_task["status"] = "needs_input"
    proof_task["needsInput"] = {"kind": "user", "reason": "verification", "question": "Smoke it"}
    state["integrationProof"]["status"] = "needs_human"
    state["integrationProof"]["artifactId"] = "A1"
    state["artifacts"] = [{
        "id": "A1",
        "kind": "integration_proof",
        "title": "Proof",
        "path": "artifacts/proof.json",
        "status": "ready_for_review",
        "createdBy": "tester-1",
        "taskId": "P1",
        "fingerprint": None,
        "reviewHistory": [],
        "recommendedTasks": [],
    }]
    write_state(fixture.state_path, state)

    status = fixture.cli.run_failure("task", "status", "--task-id", "P1", "--status", "done", "--id", "tester-1")
    assert "integration_proof_uses_proof_record" in status.stderr
    resolved = fixture.cli.run_failure("task", "resolve-input", "--task-id", "P1", "--id", "architect", "--resolution", "done", "--complete")
    assert "integration_proof_uses_proof_record" in resolved.stderr
    approved = fixture.cli.run_failure("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert "integration_proof_uses_proof_record" in approved.stderr


def test_hidden_local_human_approval_is_revision_bound(tmp_path) -> None:
    fixture = create_workspace_team(tmp_path, "workspace", "human", [
        task("T1", "Implement", "developer"),
        task("P1", "Prove", "tester", status="needs_input", owner="tester-1"),
    ])
    _repo(fixture)
    state = _required_state(fixture)
    proof_task = get_task(state, "P1")
    proof_task["status"] = "needs_input"
    proof_task["needsInput"] = {"kind": "user", "reason": "verification", "question": "Run native smoke"}
    state["integrationProof"].update({
        "mode": "human_smoke",
        "status": "needs_human",
        "artifactId": "A1",
        "revision": 1,
        "verifiedHeads": [{"repo": "primary", "sha": _git(fixture.cli.cwd, "rev-parse", "HEAD")}],
    })
    state["artifacts"] = [{
        "id": "A1",
        "kind": "integration_proof",
        "title": "Human proof",
        "path": "artifacts/human-proof.json",
        "status": "ready_for_review",
        "createdBy": "tester-1",
        "taskId": "P1",
        "fingerprint": None,
        "reviewHistory": [],
        "recommendedTasks": [],
    }]
    write_state(fixture.state_path, state)

    wrong_task = fixture.cli.run_failure("proof", "approve-human", "--task-id", "T1", "--artifact-id", "A1")
    assert "integration_proof_human_approval_stale" in wrong_task.stderr
    fixture.cli.run("proof", "approve-human", "--task-id", "P1", "--artifact-id", "A1")
    approved = read_state(fixture.state_path)
    assert approved["integrationProof"]["status"] == "valid"
    assert approved["integrationProof"]["humanApproval"]["actor"] == "local_user"
    assert get_task(approved, "P1")["status"] == "done"
    assert approved["artifacts"][0]["status"] == "approved"
