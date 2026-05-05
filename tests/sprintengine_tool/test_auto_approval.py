from __future__ import annotations

import json
import re
from pathlib import Path

from helpers import (
    assert_artifact_status,
    assert_board_column,
    assert_task_status,
    create_team,
    get_artifact,
    read_state,
    task,
)


APPROVED_AUTO_APPROVAL_KINDS = {
    "architect_plan",
    "branding",
    "code_review",
    "design_notes",
    "html_mockup",
    "performance_review",
    "product_strategy",
    "requirements",
    "security_review",
    "validation_report",
}


def write_team_file(fixture, relative_path: str, content: str = "# Artifact\n") -> None:
    path = fixture.team_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def add_ready_artifact(fixture, artifact_id: str, task_id: str, kind: str, path: str, title: str) -> None:
    write_team_file(fixture, path)
    fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "producer",
        "--artifact-id",
        artifact_id,
        "--task-id",
        task_id,
        "--kind",
        kind,
        "--title",
        title,
        "--path",
        path,
        "--created-by",
        "producer",
        "--ready",
    )


def collect_fixture_auto_approval_intents(fixture, enabled: bool) -> list[str]:
    if not enabled:
        return []

    artifact_ids: list[str] = []
    state = read_state(fixture.state_path)
    for artifact in state["artifacts"]:
        task_record = next(task_record for task_record in state["tasks"] if task_record["id"] == artifact["taskId"])
        if (
            artifact["kind"] in APPROVED_AUTO_APPROVAL_KINDS
            and artifact["status"] in {"draft", "ready_for_review", "changes_requested"}
            and artifact["path"].strip()
            and str(task_record.get("ownerAgentId") or "").strip()
        ):
            artifact_ids.append(artifact["id"])
    return artifact_ids


def test_auto_approval_disabled_leaves_ready_artifacts_waiting(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "auto-approval-disabled",
        [
            task("T1", "Requirements gate", "product", "in_progress", owner="product-fixture"),
            task("T2", "Implementation", "developer", "todo", depends_on=["T1"]),
        ],
    )
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")

    intents = collect_fixture_auto_approval_intents(fixture, enabled=False)

    state = read_state(fixture.state_path)
    assert intents == []
    assert_artifact_status(state, "A1", "ready_for_review")
    assert_task_status(state, "T1", "needs_input")
    assert_board_column(state, "T2", "todo")


def test_auto_approval_enabled_records_intent_without_mutating_artifact_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "auto-approval-enabled",
        [
            task("T1", "Requirements gate", "product", "in_progress", owner="product-fixture"),
            task("T2", "Implementation", "developer", "todo", depends_on=["T1"]),
        ],
    )
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")

    intents = collect_fixture_auto_approval_intents(fixture, enabled=True)

    state = read_state(fixture.state_path)
    artifact = get_artifact(state, "A1")
    assert intents == ["A1"]
    assert_artifact_status(state, "A1", "ready_for_review")
    assert "approvedBy" not in artifact
    assert not any(entry["action"] == "approved" for entry in artifact["reviewHistory"])
    assert_task_status(state, "T1", "needs_input")
    assert_board_column(state, "T2", "todo")


def test_auto_approval_policy_allows_only_approved_artifact_kinds(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "auto-approval-kind-policy",
        [
            task("T1", "Code review gate", "code_reviewer", "needs_input", owner="code-reviewer-fixture"),
            task("T2", "Unknown review gate", "tester", "needs_input", owner="tester-fixture"),
        ],
    )
    write_team_file(fixture, "code-review.md")
    write_team_file(fixture, "future-review.md")
    state = read_state(fixture.state_path)
    state["artifacts"] = [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Code Review",
            "path": "code-review.md",
            "status": "ready_for_review",
            "createdBy": "code-reviewer-fixture",
            "taskId": "T1",
            "reviewHistory": [],
            "recommendedTasks": [],
        },
        {
            "id": "A2",
            "kind": "future_review",
            "title": "Future Review",
            "path": "future-review.md",
            "status": "ready_for_review",
            "createdBy": "tester-fixture",
            "taskId": "T2",
            "reviewHistory": [],
            "recommendedTasks": [],
        },
    ]
    fixture.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    assert collect_fixture_auto_approval_intents(fixture, enabled=True) == ["A1"]


def test_renderer_auto_approval_policy_matches_approved_artifact_kinds() -> None:
    renderer_source = (Path(__file__).resolve().parents[2] / "src/renderer/src/utils/sprintengine.ts").read_text(encoding="utf-8")
    match = re.search(r"const reviewGateArtifactKinds = new Set<SwarmArtifactKind>\(\[([\s\S]*?)\]\)", renderer_source)
    assert match, "renderer reviewGateArtifactKinds declaration not found"

    renderer_kinds = set(re.findall(r"'([^']+)'", match.group(1)))
    assert renderer_kinds == APPROVED_AUTO_APPROVAL_KINDS


def test_electron_auto_run_sends_approval_intent_instead_of_approving_directly() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )
    main_source = (repo_root / "src/main/index.ts").read_text(encoding="utf-8")

    assert "sendArtifactApprovalToTerminal(agentSession.sessionId)" in supervisor_source
    assert "Sent the user approval intent to the responsible agent terminal." in supervisor_source
    assert "Artifact auto-approved" not in supervisor_source
    assert "action: 'approve-intent'" in main_source
    assert "id: mode === 'auto-run' ? 'auto-run' : actor.id" not in main_source
