"""Task lifecycle through the CLI surface (MC-1542 single-owner tasks).

`test_single_owner_lifecycle.py` pins the routing/walk invariants at the function
level; this module pins the same lifecycle as an agent actually drives it —
`task next` -> `task log` -> `task publish` -> `task advance` -> done — plus the
surrounding machinery the walk depends on: task-scoped roster capacity, agent
expiry and release, needs_input routing/resolution, `task status` repair
transitions, and the dispatch ledger.

There are no reviewers, no gate claims, and no `changes_requested`: the agent
that claims a task owns it through `review` to `done`.
"""
from __future__ import annotations

import argparse
import os
import subprocess

from fixtures import (
    SwarmCli,
    artifact_by_kind,
    assert_board_column,
    assert_event_type,
    assert_ready_tasks,
    assert_task_status,
    create_workspace_team,
    create_team,
    get_task,
    read_state,
    task,
    task_ids_by_status,
    write_workspace_role,
    write_state,
)
from sprintengine_core import store
from sprintengine_core.tool.commands.run import build_agent_next_directive
from sprintengine_core.tool import runner_watch_delay_seconds
from sprintengine_core.tool.tasks import normalize_task


FIXED_MTIME_NS = 1_700_000_000_000_000_000


def init_git_repo(root) -> None:
    subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Sprint Engine Test"], cwd=root, check=True)


def commit_file(root, path: str, content: str) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", path], cwd=root, check=True)
    subprocess.run(["git", "commit", "-m", f"Add {path}"], cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def run_without_state_rewrite(fixture, *args: str) -> dict:
    os.utime(fixture.state_path, ns=(FIXED_MTIME_NS, FIXED_MTIME_NS))
    before_bytes = fixture.state_path.read_bytes()
    before_mtime_ns = fixture.state_path.stat().st_mtime_ns

    payload = fixture.cli.run(*args)

    assert fixture.state_path.read_bytes() == before_bytes
    assert fixture.state_path.stat().st_mtime_ns == before_mtime_ns
    return payload


def test_ready_column_is_derived_from_todo_tasks_with_satisfied_dependencies(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "derived-ready-state",
        [
            task("T1", "Approved gate", "architect", "done"),
            task("T2", "Implementation ready by dependency", "developer", "todo", ["T1"]),
            task("T3", "Validation blocked by implementation", "tester", "todo", ["T2"]),
        ],
    )

    assert_ready_tasks(fixture.cli, "developer", ["T2"])
    state = read_state(fixture.state_path)
    assert get_task(state, "T2")["status"] == "todo"
    assert task_ids_by_status(state, "ready") == []
    assert_board_column(state, "T2", "ready")
    assert_board_column(state, "T3", "todo")


def test_needs_triage_blocks_ready_dispatch_until_cleared(tmp_path) -> None:
    triage_task = task("T2", "Needs triage before dispatch", "developer", depends_on=["T1"])
    triage_task["needsTriage"] = True
    fixture = create_team(
        tmp_path,
        "needs-triage-dispatch",
        [
            task("T1", "Done dependency", "developer", "done"),
            triage_task,
        ],
    )

    assert_ready_tasks(fixture.cli, "developer", [])
    joined = fixture.cli.run("join", "--role", "developer", "--id", "developer-fixture", "--watch", "--max-wait-seconds", "0")
    assert joined["action"] == "idle"
    next_payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert next_payload["claimed"] is False
    assert next_payload["reason"] == "no_ready_task"
    claim_payload = fixture.cli.run("task", "claim", "--task-id", "T2", "--id", "developer-fixture")
    assert claim_payload["ok"] is False
    assert claim_payload["error"] == "Task is not ready."

    projection = fixture.cli.run("projection")
    projected = next(record for record in projection["tasks"] if record["id"] == "T2")
    assert projected["needsTriage"] is True
    assert projected["boardColumn"] == "todo"
    assert projection["board"]["columns"]["todo"]["taskIds"] == ["T2"]
    assert projection["board"]["readyTaskIds"] == []

    state = read_state(fixture.state_path)
    get_task(state, "T2")["needsTriage"] = False
    write_state(fixture.state_path, state)

    assert_ready_tasks(fixture.cli, "developer", ["T2"])
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T2"


def test_task_normalization_defaults_and_preserves_needs_triage() -> None:
    base = task("T1", "Normalize task", "developer")

    assert normalize_task(base)["needsTriage"] is False
    assert normalize_task({**base, "needsTriage": True})["needsTriage"] is True


def test_task_status_needs_input_records_routing_metadata_and_triage_prompt(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-routing", [
        task("T1", "Fix stale task card", "frontend", "in_progress", owner="frontend-1"),
    ])

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "frontend-1",
        "--needs-input-kind",
        "architect",
        "--needs-input-question",
        "Task card points at a file that no longer exists.",
        "--needs-input-suggested-resolution",
        "Architect should update ownedPaths and acceptance criteria.",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["needsInput"]["kind"] == "architect"
    assert task_record["needsInput"]["question"] == "Task card points at a file that no longer exists."
    assert task_record["needsInput"]["suggestedResolution"] == "Architect should update ownedPaths and acceptance criteria."
    assert task_record["needsInput"]["reportedBy"] == "frontend-1"

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")
    assert triage["ok"] is True
    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert "Task card points at a file that no longer exists." in triage["prompt"]
    assert "sprintengine plan update-task --force" in triage["prompt"]


def test_task_status_needs_input_records_reason_and_artifact_id(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-artifact-review-routing", [
        task("T1", "Review phase output", "security", "in_progress", owner="security"),
    ])

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "security",
        "--needs-input-kind",
        "architect",
        "--needs-input-reason",
        "artifact_review",
        "--needs-input-artifact-id",
        "A6",
        "--needs-input-question",
        "Code review artifact A6 has recommended follow-up tasks.",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["needsInput"]["kind"] == "architect"
    assert task_record["needsInput"]["reason"] == "artifact_review"
    assert task_record["needsInput"]["artifactId"] == "A6"

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")
    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert "artifact_review" in triage["prompt"]
    assert "A6" in triage["prompt"]


def test_artifact_review_needs_input_routes_to_architect_triage(tmp_path) -> None:
    blocked_task = task("T1", "Review artifact", "security", "needs_input", owner="security")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "artifact_review",
        "question": "Artifact A6 is ready for review.",
        "reportedBy": "security",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "artifact-review-routes-to-architect", [blocked_task])

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")

    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert triage["tasks"][0]["needsInput"]["kind"] == "architect"
    assert triage["tasks"][0]["needsInput"]["reason"] == "artifact_review"
    assert "artifact_review" in triage["prompt"]


def test_task_status_rejects_needs_input_fields_for_other_statuses(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-field-rejection", [
        task("T1", "Normal task", "developer", "in_progress", owner="developer-1"),
    ])

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-1",
        "--needs-input-kind",
        "architect",
    )

    assert "Needs-input fields are only supported with --status needs_input" in rejected.stderr


def owned_task(status: str = "in_progress", owner: str | None = "developer-fixture", phases: list[str] | None = None) -> dict:
    """A task bound to one owner from claim to done.

    `phases=[]` opts the task out of review, so publish routes straight to `done`
    (the docs-only / no-review exit). Omit it to inherit the run's `defaultPhases`.
    """
    record = task("T1", "Single-owner implementation", "developer", status, owner=owner)
    if phases is not None:
        record["phases"] = phases
    if status != "todo":
        record["startedAt"] = "2026-07-08T00:00:00Z"
    return record


def test_task_note_routes_architect_actor_to_architect_feedback_comment(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-note-architect",
        [task("T1", "Implement feature", "developer", "in_progress", owner="developer-fixture")],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "architect-fixture": {"role": "architect", "status": "idle", "currentTaskId": None},
        "developer-fixture": {"role": "developer", "status": "running", "currentTaskId": "T1"},
    }
    write_state(fixture.state_path, state)

    payload = fixture.cli.run(
        "task",
        "note",
        "--task-id",
        "T1",
        "--id",
        "architect-fixture",
        "--note",
        "Reviewer's finding is out of scope; ship as-is.",
    )

    assert payload["ok"] is True
    assert payload["comment"]["type"] == "architect_feedback"
    assert payload["comment"]["body"] == "Reviewer's finding is out of scope; ship as-is."
    assert payload["comment"]["authorRole"] == "architect"

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    # Runtime notes no longer pollute the planning-notes bag.
    assert task_record["notes"] == []
    assert any(
        comment["type"] == "architect_feedback" and "out of scope" in comment["body"]
        for comment in task_record["comments"]
    )
    # Activity entry carries the body so it surfaces in the inspector feed
    # instead of the boilerplate "added a note" verb.
    assert any(
        entry["type"] == "comment" and "out of scope" in entry["message"]
        for entry in task_record.get("activity", [])
    )


def test_task_note_from_non_architect_actor_uses_user_note_type(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-note-developer",
        [task("T1", "Implement feature", "developer", "in_progress", owner="developer-fixture")],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "running", "currentTaskId": "T1"},
    }
    write_state(fixture.state_path, state)

    payload = fixture.cli.run(
        "task",
        "note",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--note",
        "Pausing while I refresh the local env.",
    )

    assert payload["comment"]["type"] == "user_note"
    assert payload["comment"]["authorRole"] == "developer"
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["notes"] == []
    assert any(
        comment["body"] == "Pausing while I refresh the local env."
        for comment in task_record["comments"]
    )


def test_task_publish_requires_summary_before_leaving_in_progress(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-summary-required", [owned_task()])

    rejected = fixture.cli.run_failure(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        " ",
    )

    assert "Task comment body cannot be empty" in rejected.stderr
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "in_progress")


def test_task_publish_records_implementation_summary_and_enters_the_review_phase(tmp_path) -> None:
    # A task that produced changes enters phases[0] and the OWNER STAYS BOUND: it
    # is mid-tool-call and gets its phase directive back inline.
    fixture = create_team(tmp_path, "publish-routes-review", [owned_task()])
    fixture.cli.run("runner", "set", "--mode", "auto")

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Implemented the backend path.",
        "--path",
        "sprintengine_core/tool.py",
    )

    assert payload["nextStatus"] == "review"
    assert payload["producedChanges"] is True
    assert payload["phases"] == ["review"]
    assert payload["nextDirective"]
    assert payload["committed"] is False
    assert payload["commitSha"] is None
    assert payload["nextCommand"] == "sprintengine join --role developer --id developer-fixture --watch"
    assert "Auto Mode is on" in payload["nextAction"]
    assert payload["comment"]["type"] == "implementation_summary"
    assert payload["comment"]["id"] == "C1"
    assert payload["comment"]["authorAgentId"] == "developer-fixture"
    assert payload["comment"]["authorRole"] == "developer"
    assert payload["comment"]["paths"] == ["sprintengine_core/tool.py"]
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "review"
    assert task_record["ownerAgentId"] == "developer-fixture"
    assert task_record["lastImplementedByAgentId"] == "developer-fixture"
    assert task_record["lastPublishedAt"]
    assert task_record["completedAt"] is None
    assert task_record["comments"][0]["body"] == "Implemented the backend path."
    assert state["agents"]["developer-fixture"]["currentTaskId"] == "T1"


def test_task_advance_out_of_review_completes_the_task(tmp_path) -> None:
    fixture = create_team(tmp_path, "advance-completes", [owned_task()])
    fixture.cli.run("runner", "set", "--mode", "auto")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Implemented it.")

    payload = fixture.cli.run(
        "task",
        "advance",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--phase",
        "review",
        "--outcome",
        "pass_with_fixes",
        "--summary",
        "Reviewed my diff; fixed a nil guard.",
    )

    assert payload["nextStatus"] == "done"
    assert "nextPhase" not in payload
    assert "nextDirective" not in payload
    assert payload["nextCommand"] == "sprintengine join --role developer --id developer-fixture --watch"
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "done"
    assert task_record["completedAt"]
    assert task_record["ownerAgentId"] is None
    assert state["agents"]["developer-fixture"]["status"] == "idle"
    assert_event_type(state, "task_phase_advanced")


def test_task_advance_is_owner_only_and_guards_on_the_current_phase(tmp_path) -> None:
    fixture = create_team(tmp_path, "advance-guards", [owned_task("review")])

    not_owner = fixture.cli.run_failure(
        "task", "advance", "--task-id", "T1", "--id", "developer-2",
        "--phase", "review", "--outcome", "pass", "--summary", "Looks fine.",
    )
    assert "not_task_owner" in not_owner.stderr

    fixture.cli.run(
        "task", "advance", "--task-id", "T1", "--id", "developer-fixture",
        "--phase", "review", "--outcome", "pass", "--summary", "Reviewed.",
    )
    replayed = fixture.cli.run_failure(
        "task", "advance", "--task-id", "T1", "--id", "developer-fixture",
        "--phase", "review", "--outcome", "pass", "--summary", "Reviewed again.",
    )
    assert "phase_mismatch" in replayed.stderr
    assert_task_status(read_state(fixture.state_path), "T1", "done")


def test_task_advance_escalate_parks_the_task_and_resolution_returns_it_to_review(tmp_path) -> None:
    # Invariant 7c: an escalation from a phase remembers that phase, so resolving
    # the input resumes the review — it does not re-open implementation.
    fixture = create_team(tmp_path, "advance-escalate", [owned_task("review")])

    escalated = fixture.cli.run(
        "task", "advance", "--task-id", "T1", "--id", "developer-fixture",
        "--phase", "review", "--outcome", "escalate", "--summary", "Contract is ambiguous.",
        "--needs-input-kind", "architect",
        "--needs-input-question", "Which contract owns the retry budget?",
    )
    assert escalated["nextStatus"] == "needs_input"

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["needsInput"]["originatingStatus"] == "review"
    assert task_record["ownerAgentId"] == "developer-fixture"

    resolved = fixture.cli.run(
        "task", "resolve-input", "--task-id", "T1", "--id", "architect",
        "--resolution", "The caller owns it. Continue reviewing.",
    )
    assert resolved["transition"] == {
        "status": "review",
        "ownerAgentId": "developer-fixture",
        "resumePhase": "review",
    }
    assert_task_status(read_state(fixture.state_path), "T1", "review")


def test_task_publish_with_no_phases_completes_the_task(tmp_path) -> None:
    # `--phases ""` on a docs-only task: publish routes straight to done, no review.
    fixture = create_team(tmp_path, "publish-no-phases", [owned_task(phases=[])])

    payload = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Docs only.")

    assert payload["nextStatus"] == "done"
    assert payload["producedChanges"] is True
    assert payload["phases"] == []
    assert "nextDirective" not in payload
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    task_record = get_task(state, "T1")
    assert task_record["completedAt"]
    assert task_record["ownerAgentId"] is None


def test_task_publish_captures_diff_evidence_for_declared_paths(tmp_path) -> None:
    init_git_repo(tmp_path)
    commit_file(tmp_path, "src/example.py", "def value():\n    return 'old'\n")
    record = owned_task()
    fixture = create_team(tmp_path, "publish-diff-evidence", [record])
    (tmp_path / "src" / "example.py").write_text("def value():\n    return 'new'\n", encoding="utf-8")

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Updated the example.",
        "--path",
        "src/example.py",
    )

    diffs = payload["task"]["evidence"]["diffs"]
    assert len(diffs) == 1
    assert diffs[0]["path"] == "src/example.py"
    assert diffs[0]["status"] == "modified"
    assert diffs[0]["additions"] == 1
    assert diffs[0]["deletions"] == 1
    lines = diffs[0]["hunks"][0]["lines"]
    assert any(line["type"] == "removed" and "old" in line["content"] for line in lines)
    assert any(line["type"] == "added" and "new" in line["content"] for line in lines)


def test_task_publish_skips_secret_sensitive_diff_content(tmp_path) -> None:
    init_git_repo(tmp_path)
    commit_file(tmp_path, ".env", "TOKEN=old\n")
    record = owned_task()
    fixture = create_team(tmp_path, "publish-secret-diff-skip", [record])
    (tmp_path / ".env").write_text("TOKEN=new\n", encoding="utf-8")

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Updated local environment settings.",
        "--path",
        ".env",
    )

    diffs = payload["task"]["evidence"]["diffs"]
    assert diffs == [
        {
            "path": ".env",
            "status": "modified",
            "additions": 0,
            "deletions": 0,
            "capturedBy": "developer-fixture",
            "source": "working_tree",
            "binary": False,
            "truncated": False,
            "skippedReason": "secret_sensitive_path",
            "hunks": [],
            "capturedAt": diffs[0]["capturedAt"],
        }
    ]


def test_task_publish_persists_structured_summary_data(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-summary-data", [owned_task()])

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Implemented the backend path.",
        "--summary-data-json",
        '{"changedContracts":[{"name":"task lifecycle"}],"verification":[{"command":"pytest","result":"passed"}],"reviewerFocus":["routing"]}',
    )

    assert payload["comment"]["type"] == "implementation_summary"
    assert payload["comment"]["data"]["changedContracts"][0]["name"] == "task lifecycle"
    assert payload["comment"]["data"]["verification"][0]["result"] == "passed"
    assert payload["comment"]["data"]["reviewerFocus"] == ["routing"]


def test_plan_add_and_update_task_persist_architect_difficulty_estimate(tmp_path) -> None:
    fixture = create_team(tmp_path, "plan-difficulty", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-a": {"role": "developer", "status": "idle", "currentTaskId": None}}
    write_state(fixture.state_path, state)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Implement difficult feature",
        "--role",
        "developer",
        "--difficulty-pct",
        "42",
        "--difficulty-reason",
        "Several integration points.",
    )
    assert added["task"]["difficulty"] == {
        "architectEstimatePct": 42,
        "architectEstimateReason": "Several integration points.",
    }

    updated = fixture.cli.run(
        "plan",
        "update-task",
        "--task-id",
        added["task"]["id"],
        "--difficulty-pct",
        "55",
        "--difficulty-reason",
        "State model expanded.",
    )
    assert updated["task"]["difficulty"] == {
        "architectEstimatePct": 55,
        "architectEstimateReason": "State model expanded.",
    }


def test_task_publish_records_implementer_actual_difficulty(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-actual-difficulty", [owned_task()])

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Implemented the backend path.",
        "--actual-difficulty-pct",
        "63",
        "--actual-difficulty-reason",
        "Moderate state coordination.",
    )

    assert payload["task"]["difficulty"] == {
        "implementerActualPct": 63,
        "implementerActualReason": "Moderate state coordination.",
    }


def test_old_task_without_difficulty_still_loads_and_dispatches(tmp_path) -> None:
    fixture = create_team(tmp_path, "old-task-no-difficulty", [task("T1", "Old task", "developer")])
    state = read_state(fixture.state_path)
    get_task(state, "T1").pop("difficulty", None)
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert payload["claimed"] is True
    assert payload["task"]["id"] == "T1"
    assert "difficulty" not in payload["task"]


def test_task_publish_with_no_changes_completes_the_task(tmp_path) -> None:
    # The clean-sweep / analysis-only exit: change detection finds no diff, every
    # phase is skipped, the task lands on done. Publish routes on CHANGE
    # DETECTION, never on role or configuration.
    init_git_repo(tmp_path)
    commit_file(tmp_path, "src/untouched.py", "value = 1\n")
    record = owned_task()
    record["ownedPaths"] = ["src/untouched.py"]
    fixture = create_team(tmp_path, "publish-no-changes", [record])

    payload = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Swept; nothing to change.",
    )

    assert payload["producedChanges"] is False
    assert payload["nextStatus"] == "done"
    assert payload["phases"] == []
    final_state = read_state(fixture.state_path)
    assert_task_status(final_state, "T1", "done")
    assert get_task(final_state, "T1")["completedAt"]


def test_republish_after_human_feedback_records_a_response_and_re_enters_review(tmp_path) -> None:
    # Flow 5: human feedback re-opens implementation. The rework publish answers
    # the open feedback comment (`implementation_response`) and restarts the walk
    # at phases[0] — the whole diff is reviewed again, which is cheap and safe.
    record = owned_task()
    record["comments"] = [
        {
            "id": "C1",
            "type": "review_feedback",
            "actor": "user",
            "authorAgentId": "user",
            "source": "user",
            "body": "Tweak the copy.",
            "createdAt": "2026-07-08T00:00:00Z",
            "data": {"status": "open", "reason": "Tweak the copy."},
        }
    ]
    fixture = create_team(tmp_path, "publish-rework-response", [record])

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Tweaked the copy.",
    )

    assert payload["nextStatus"] == "review"
    assert payload["comment"]["type"] == "implementation_response"
    assert payload["comment"]["data"]["feedbackCommentIds"] == ["C1"]
    task_record = get_task(read_state(fixture.state_path), "T1")
    assert task_record["status"] == "review"
    # The republisher owns the task through its restarted walk.
    assert task_record["ownerAgentId"] == "developer-fixture"
    assert task_record["lastImplementedByAgentId"] == "developer-fixture"


def test_rework_publish_refreshes_latest_diff_snapshot(tmp_path) -> None:
    init_git_repo(tmp_path)
    commit_file(tmp_path, "src/rework.py", "value = 'base'\n")
    record = owned_task()
    record["evidence"]["touchedFiles"] = ["src/rework.py"]
    record["evidence"]["diffs"] = [
        {
            "path": "src/rework.py",
            "status": "modified",
            "additions": 1,
            "deletions": 1,
            "capturedAt": "2026-07-08T00:00:00Z",
            "capturedBy": "developer-fixture",
            "source": "working_tree",
            "binary": False,
            "truncated": False,
            "skippedReason": None,
            "hunks": [
                {
                    "oldStart": 1,
                    "oldLines": 1,
                    "newStart": 1,
                    "newLines": 1,
                    "section": None,
                    "lines": [{"type": "added", "oldLine": None, "newLine": 1, "content": "value = 'stale'"}],
                }
            ],
        }
    ]
    fixture = create_team(tmp_path, "publish-rework-diff-refresh", [record])
    (tmp_path / "src" / "rework.py").write_text("value = 'fresh'\n", encoding="utf-8")

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Refreshed the implementation.",
    )

    diffs = payload["task"]["evidence"]["diffs"]
    assert len(diffs) == 1
    lines = diffs[0]["hunks"][0]["lines"]
    assert any(line["type"] == "added" and "fresh" in line["content"] for line in lines)
    assert not any("stale" in line["content"] for line in lines)


def test_runner_set_persists_policy_and_projection(tmp_path) -> None:
    fixture = create_team(tmp_path, "runner-policy", [task("T1", "Implement", "developer")])

    payload = fixture.cli.run("runner", "set", "--mode", "auto", "--poll-interval-seconds", "2", "--idle-backoff-seconds", "3")

    assert payload["runner"]["cliWatchPolling"] == "enabled"
    assert payload["runner"]["pollIntervalSeconds"] == 2
    state = read_state(fixture.state_path)
    assert state["runner"]["cliWatchPolling"] == "enabled"
    projection = fixture.cli.run("projection")
    assert projection["run"]["runner"]["cliWatchPolling"] == "enabled"

    off_payload = fixture.cli.run("runner", "set", "--mode", "off")
    assert off_payload["runner"]["cliWatchPolling"] == "disabled"
    assert read_state(fixture.state_path)["runner"]["cliWatchPolling"] == "disabled"


def test_runner_watch_delay_progressively_caps() -> None:
    policy = {"pollIntervalSeconds": 2, "idleBackoffSeconds": 3, "maxBackoffSeconds": 10}

    assert [runner_watch_delay_seconds(policy, attempts) for attempts in range(1, 6)] == [2, 3, 6, 10, 10]


def test_join_watch_returns_idle_when_auto_mode_is_off_without_work(tmp_path) -> None:
    fixture = create_team(tmp_path, "join-watch-auto-off-idle", [task("T1", "Frontend work", "frontend", "todo")])

    payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-1", "--watch", "--max-wait-seconds", "0")

    assert payload["action"] == "idle"
    assert payload["runner"]["cliWatchPolling"] == "disabled"
    assert "CLI watch polling is disabled" in payload["message"]


def test_join_watch_resumes_an_owner_parked_in_its_review_phase(tmp_path) -> None:
    # `review` is owned, so its owner reconnects to it rather than being offered
    # the ready task queued behind it. A stranger sees no ready work at all.
    review_task = owned_task("review", owner="developer-fixture")
    fixture = create_team(tmp_path, "join-watch-review-resume", [review_task])
    fixture.cli.run("runner", "set", "--mode", "auto")

    owner = fixture.cli.run("join", "--role", "developer", "--id", "developer-fixture", "--watch", "--max-wait-seconds", "0")
    stranger = fixture.cli.run("join", "--role", "developer", "--id", "developer-2", "--watch", "--max-wait-seconds", "0")

    assert owner["action"] == "resume"
    assert owner["task"]["id"] == "T1"
    assert "`review` phase" in owner["prompt"]
    assert stranger["action"] == "idle"
    assert get_task(read_state(fixture.state_path), "T1")["ownerAgentId"] == "developer-fixture"


def test_temporary_marketer_role_owns_a_task_through_its_review_phase(tmp_path) -> None:
    # A workspace-layer role gets the same single-owner walk as a built-in one:
    # it claims, publishes into its own review, and advances itself to done. Its
    # `directives.review` pack rides the phase directive.
    workspace = tmp_path / "custom-role-workspace"
    write_workspace_role(workspace, "marketer", aliases=["growth-marketer"], review_skill="marketer_review")
    review_skill_dir = workspace / ".sprintengine" / "skills" / "marketer_review"
    review_skill_dir.mkdir(parents=True, exist_ok=True)
    (review_skill_dir / "SKILL.md").write_text("# marketer_review\n\nCheck the headline reads as a product statement.", encoding="utf-8")

    marketer_task = task("T1", "Draft launch post", "marketer")
    fixture = create_workspace_team(tmp_path, "custom-role-workspace", "custom-role-phases", [marketer_task])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"marketer-1": {"role": "marketer", "status": "idle", "currentTaskId": None}}
    write_state(fixture.state_path, state)

    claimed = fixture.cli.run("task", "next", "--role", "growth-marketer", "--id", "marketer-1")
    assert claimed["claimed"] is True
    assert claimed["task"]["role"] == "marketer"

    published = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "marketer-1", "--summary", "Drafted the post.")
    assert published["nextStatus"] == "review"
    assert "marketer additions for this phase" in published["nextDirective"]
    assert "reads as a product statement" in published["nextDirective"]
    assert get_task(read_state(fixture.state_path), "T1")["ownerAgentId"] == "marketer-1"

    completed = fixture.cli.run(
        "task", "advance", "--task-id", "T1", "--id", "marketer-1",
        "--phase", "review", "--outcome", "pass", "--summary", "Headline reads clean.",
    )
    assert completed["nextStatus"] == "done"
    assert_task_status(read_state(fixture.state_path), "T1", "done")


def test_join_watch_routes_architect_needs_input_before_ready_task(tmp_path) -> None:
    blocked = task("T1", "Needs architect decision", "developer", "needs_input", owner="developer-1")
    blocked["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Should this task own the shared contract?",
    }
    ready_architect = task("T2", "Architect normal task", "architect")
    fixture = create_team(tmp_path, "join-watch-architect-triage", [blocked, ready_architect])
    fixture.cli.run("runner", "set", "--mode", "auto")

    payload = fixture.cli.run("join", "--role", "architect", "--id", "architect", "--watch", "--max-wait-seconds", "0")

    assert payload["action"] == "needs_input_triage"
    assert "triage needs-input" in payload["prompt"]


def test_join_watch_stops_owner_on_unresolved_needs_input(tmp_path) -> None:
    blocked = task("T1", "Needs product decision", "developer", "needs_input", owner="developer-1")
    blocked["needsInput"] = {
        "kind": "user",
        "reason": "product_decision",
        "question": "Which export format should ship?",
        "reportedBy": "developer-1",
        "reportedAt": "2026-05-25T00:00:00Z",
    }
    fixture = create_team(tmp_path, "join-watch-owner-needs-input-stops", [blocked])
    fixture.cli.run("runner", "set", "--mode", "auto")

    payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-1", "--watch", "--max-wait-seconds", "0")

    assert payload["action"] == "blocked"
    assert payload["blocker"]["reason"] == "needs_input"
    assert payload["blocker"]["kind"] == "user"
    assert "Stop until the blocker is resolved" in payload["message"]


def test_agent_next_directive_stops_owner_on_unresolved_needs_input(tmp_path) -> None:
    blocked = task("T1", "Needs product decision", "developer", "needs_input", owner="developer-1")
    blocked["needsInput"] = {
        "kind": "user",
        "reason": "product_decision",
        "question": "Which export format should ship?",
        "reportedBy": "developer-1",
        "reportedAt": "2026-05-25T00:00:00Z",
    }
    fixture = create_team(tmp_path, "next-directive-owner-needs-input-stops", [blocked])
    fixture.cli.run("runner", "set", "--mode", "auto")

    payload = build_agent_next_directive(argparse.Namespace(
        state=fixture.state_path,
        role="developer",
        id="developer-1",
        attempts=1,
    ))

    assert payload["directiveType"] == "blocked"
    assert payload["nextMcpToolName"] is None
    assert payload["nextMcpArguments"] is None
    assert payload["blocker"]["reason"] == "needs_input"
    assert payload["blocker"]["kind"] == "user"
    assert payload["task"]["id"] == "T1"


def test_task_next_stops_owner_on_unresolved_needs_input(tmp_path) -> None:
    blocked = task("T1", "Needs product decision", "developer", "needs_input", owner="developer-1")
    blocked["needsInput"] = {
        "kind": "user",
        "reason": "product_decision",
        "question": "Which export format should ship?",
        "reportedBy": "developer-1",
        "reportedAt": "2026-05-25T00:00:00Z",
    }
    fixture = create_team(tmp_path, "task-next-owner-needs-input-stops", [blocked])

    payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    assert payload["claimed"] is False
    assert payload["reason"] == "task_needs_input"
    assert payload["blocker"]["reason"] == "needs_input"
    assert payload["blocker"]["kind"] == "user"
    assert "prompt" not in payload


def test_task_status_done_completes_an_owned_task_and_releases_its_owner(tmp_path) -> None:
    # `task status --status done` is the direct-completion repair transition, kept
    # for tasks that never entered the walk. Nothing gates it any more.
    fixture = create_team(
        tmp_path,
        "status-done-releases-owner",
        [task("T1", "Directly completed task", "developer", "in_progress", owner="developer-fixture")],
    )

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    assert payload["ok"] is True
    assert "nextCommand" not in payload
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert get_task(state, "T1")["ownerAgentId"] is None
    assert get_task(state, "T1")["lastImplementedByAgentId"] == "developer-fixture"

    # Completing straight out of `review` is allowed too, and in Auto Mode the
    # worker is handed its next command.
    fixture = create_team(
        tmp_path,
        "status-done-auto-mode",
        [task("T1", "Completed from review", "developer", "review", owner="developer-fixture")],
    )
    fixture.cli.run("runner", "set", "--mode", "auto")

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    assert payload["ok"] is True
    assert payload["nextCommand"] == "sprintengine join --role developer --id developer-fixture --watch"
    assert "Auto Mode is on" in payload["nextAction"]
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert get_task(state, "T1")["ownerAgentId"] is None
    assert get_task(state, "T1")["lastImplementedByAgentId"] == "developer-fixture"


def test_task_status_done_captures_diff_evidence_before_completion(tmp_path) -> None:
    init_git_repo(tmp_path)
    commit_file(tmp_path, "src/done.py", "result = 'before'\n")
    fixture = create_team(tmp_path, "done-diff-evidence", [
        task("T1", "Complete implementation", "developer", "in_progress", owner="developer-fixture"),
    ])
    (tmp_path / "src" / "done.py").write_text("result = 'after'\n", encoding="utf-8")
    fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--file",
        "src/done.py",
    )

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    assert payload["ok"] is True
    diffs = payload["task"]["evidence"]["diffs"]
    assert len(diffs) == 1
    assert diffs[0]["path"] == "src/done.py"
    assert any(line["type"] == "added" and "after" in line["content"] for line in diffs[0]["hunks"][0]["lines"])


def test_active_task_statuses_keep_the_run_executing_and_keep_the_owner(tmp_path) -> None:
    # ACTIVE_TASK_STATUSES is exactly {in_progress, review, needs_input}: each keeps
    # the run executing, and each keeps the task bound to its owner. `review` is a
    # phase status entered only by publish/advance (never `task status` — see
    # test_task_publish_to_review_keeps_run_executing), so it is exercised there.
    for status in ["needs_input"]:
        record = task("T1", f"{status} work", "developer", "in_progress", owner="developer-fixture")
        fixture = create_team(tmp_path, f"run-executing-{status.replace('_', '-')}", [record])
        state = read_state(fixture.state_path)
        state["sprintengine"]["status"] = "planned"
        write_state(fixture.state_path, state)

        fixture.cli.run("task", "status", "--task-id", "T1", "--status", status, "--id", "developer-fixture")

        state = read_state(fixture.state_path)
        assert state["sprintengine"]["status"] == "executing"
        assert_task_status(state, "T1", status)
        assert get_task(state, "T1")["ownerAgentId"] == "developer-fixture"
        assert state["agents"]["developer-fixture"]["currentTaskId"] == "T1"


def test_task_publish_to_review_keeps_run_executing(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-review-run-executing", [owned_task()])
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Ready.")

    assert payload["nextStatus"] == "review"
    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "executing"


def test_done_and_canceled_tasks_complete_run(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "done-canceled-run-completed",
        [
            task("T1", "Completed task", "developer", "done"),
            task("T2", "Canceled task", "tester", "in_progress", owner="tester-fixture"),
        ],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "status", "--task-id", "T2", "--status", "canceled", "--id", "tester-fixture")

    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "completed"


def test_all_canceled_tasks_complete_run_as_terminal_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "all-canceled-run-completed",
        [
            task("T1", "Canceled task", "developer", "in_progress", owner="developer-fixture"),
            task("T2", "Already canceled task", "tester", "canceled"),
        ],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "canceled", "--id", "developer-fixture")

    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "completed"


def test_task_comment_add_and_list_use_structured_comment_shape(tmp_path) -> None:
    fixture = create_team(tmp_path, "structured-task-comments", [task("T1", "Implementation", "developer")])

    added = fixture.cli.run(
        "task",
        "comment",
        "add",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--source",
        "agent",
        "--type",
        "implementation_summary",
        "--body",
        "Implementation note.",
        "--path",
        "sprintengine_core/tool.py",
        "--data-json",
        '{"reviewerFocus":["path validation"]}',
    )
    listed = fixture.cli.run("task", "comment", "list", "--task-id", "T1")

    assert added["comment"]["id"] == "C1"
    assert added["comment"]["type"] == "implementation_summary"
    assert added["comment"]["authorAgentId"] == "developer-fixture"
    assert added["comment"]["authorRole"] == "developer"
    assert added["comment"]["data"]["reviewerFocus"] == ["path validation"]
    assert listed["comments"] == [added["comment"]]


def test_task_status_todo_releases_owner_and_makes_task_claimable(tmp_path) -> None:
    releasable_task = task("T1", "Too large for current context", "frontend", "in_progress", owner="frontend-1")
    releasable_task["startedAt"] = "2026-05-14T09:00:00Z"
    fixture = create_team(tmp_path, "todo-release-clears-owner", [
        releasable_task,
    ])

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "todo", "--id", "frontend-1")

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "todo"
    assert task_record["ownerAgentId"] is None
    assert task_record["startedAt"] is None
    assert task_record["completedAt"] is None
    assert state["agents"]["frontend-1"]["status"] == "idle"
    assert state["agents"]["frontend-1"]["currentTaskId"] is None
    assert_ready_tasks(fixture.cli, "frontend", ["T1"])

    claimed = fixture.cli.run("task", "next", "--role", "frontend", "--id", "frontend-2")
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T1"
    assert claimed["task"]["ownerAgentId"] == "frontend-2"


def test_task_resolve_input_resumes_original_owner_with_notification(tmp_path) -> None:
    blocked_task = task("T1", "Blocked implementation", "frontend", "needs_input", owner="frontend-1")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Scope mismatch.",
        "reportedBy": "frontend-1",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "resolve-input-resumes-owner", [blocked_task])

    payload = fixture.cli.run(
        "task",
        "resolve-input",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--resolution",
        "Scope narrowed; continue.",
    )

    assert payload["ok"] is True
    # No `originatingStatus`, so the owner resumes implementation rather than a phase.
    assert payload["transition"] == {"status": "in_progress", "ownerAgentId": "frontend-1", "resumePhase": None}
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "in_progress"
    assert task_record["ownerAgentId"] == "frontend-1"
    assert task_record["needsInput"]["resolvedBy"] == "architect"
    assert task_record["needsInput"]["resolution"] == "Scope narrowed; continue."
    assert task_record["needsInput"]["resumeRequestedAt"]
    assert state["agents"]["frontend-1"]["status"] == "running"
    assert state["agents"]["frontend-1"]["currentTaskId"] == "T1"
    notification = state["events"][-1]
    assert notification["type"] == "agent_notification_requested"
    assert notification["targetAgentId"] == "frontend-1"
    assert notification["taskId"] == "T1"
    assert notification["notificationKind"] == "task_resume_requested"


def test_task_resolve_input_complete_marks_done_and_notifies_owner(tmp_path) -> None:
    blocked_task = task("T1", "Blocked on an artifact decision", "developer", "needs_input", owner="developer-1")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "artifact_review",
        "question": "Artifact needs adjudication.",
        "reportedBy": "developer-1",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "resolve-input-completes-task", [blocked_task])

    payload = fixture.cli.run(
        "task",
        "resolve-input",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--resolution",
        "Artifact adjudicated; nothing left to do.",
        "--complete",
    )

    assert payload["ok"] is True
    assert payload["transition"] == {"status": "done", "ownerAgentId": "developer-1", "resumePhase": None}
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "done"
    assert task_record["completedAt"]
    assert state["agents"]["developer-1"]["status"] == "idle"
    notification = state["events"][-1]
    assert notification["type"] == "agent_notification_requested"
    assert notification["notificationKind"] == "task_completed_after_input_resolution"


def test_task_resolve_input_rejects_unowned_resume_without_complete(tmp_path) -> None:
    blocked_task = task("T1", "Unowned blocker", "frontend", "needs_input")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Needs a decision.",
        "reportedBy": "frontend-1",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "resolve-input-unowned-rejected", [blocked_task])

    rejected = fixture.cli.run_failure(
        "task",
        "resolve-input",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--resolution",
        "Continue.",
    )

    assert "without an owner" in rejected.stderr


def test_task_release_clears_active_owner_and_notifies_previous_owner(tmp_path) -> None:
    active_task = task("T1", "Abandoned task", "frontend", "in_progress", owner="frontend-1")
    active_task["startedAt"] = "2026-05-14T09:00:00Z"
    fixture = create_team(tmp_path, "task-release", [active_task])

    payload = fixture.cli.run(
        "task",
        "release",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--reason",
        "Original worker inactive.",
    )

    assert payload["ok"] is True
    assert payload["transition"] == {"previousOwnerAgentId": "frontend-1", "status": "todo"}
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "todo"
    assert task_record["ownerAgentId"] is None
    assert state["agents"]["frontend-1"]["status"] == "idle"
    assert_ready_tasks(fixture.cli, "frontend", ["T1"])
    notification = state["events"][-1]
    assert notification["type"] == "agent_notification_requested"
    assert notification["notificationKind"] == "task_released_from_owner"


def test_task_status_requires_question_for_routed_needs_input(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-question-required", [
        task("T1", "Ambiguous blocker", "frontend", "in_progress", owner="frontend-1"),
    ])

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "frontend-1",
        "--needs-input-kind",
        "architect",
    )

    assert "--needs-input-question is required" in rejected.stderr


def test_bare_needs_input_keeps_legacy_status_without_routing_metadata(tmp_path) -> None:
    blocked_task = task("T1", "Legacy blocker", "developer", "in_progress", owner="developer-1")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "question": "Old routed blocker.",
        "reportedBy": "developer-1",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "bare-needs-input", [blocked_task])

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "developer-1",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "needs_input"
    assert "needsInput" not in task_record


def test_product_and_architect_artifact_approvals_control_downstream_readiness(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "approval-gates" / "run.yaml"
    cli = SwarmCli(state_path)

    init_payload = cli.run("init", "--goal", "Exercise approval gates")
    assert init_payload["ok"] is True
    assert init_payload["action"] == "initialized"
    assert "role" not in init_payload
    assert "prompt" not in init_payload

    state = read_state(state_path)
    product_task = init_payload["productTask"]
    plan_task = init_payload["planTask"]
    assert_task_status(state, product_task["id"], "todo")
    assert get_task(state, product_task["id"])["ownerAgentId"] is None
    assert_task_status(state, plan_task["id"], "todo")
    assert_board_column(state, product_task["id"], "ready")
    assert_board_column(state, plan_task["id"], "todo")
    assert_ready_tasks(cli, "product", [product_task["id"]])
    assert_ready_tasks(cli, "architect", [])

    claimed = cli.run("task", "next", "--role", "product", "--id", "product-fixture")
    assert claimed["claimed"] is True
    claimed_state = read_state(state_path)
    assert_task_status(claimed_state, product_task["id"], "in_progress")
    assert get_task(claimed_state, product_task["id"])["ownerAgentId"] == "product-fixture"

    product_artifact = init_payload["productArtifact"]
    (state_path.parent / "product-requirements.md").write_text("# Product Requirements\n", encoding="utf-8")
    cli.run("artifact", "ready", "--artifact-id", product_artifact["id"], "--id", "product-fixture")
    cli.run("artifact", "approve", "--artifact-id", product_artifact["id"], "--id", "user")

    product_approved = read_state(state_path)
    assert_task_status(product_approved, product_task["id"], "done")
    assert_board_column(product_approved, plan_task["id"], "ready")
    assert_ready_tasks(cli, "architect", [plan_task["id"]])

    cli.run(
        "task",
        "next",
        "--role",
        "architect",
        "--id",
        "architect-fixture",
    )
    plan_artifact = artifact_by_kind(read_state(state_path), "architect_plan")
    (state_path.parent / "plan.md").write_text("# Architect Plan\n", encoding="utf-8")
    cli.run("artifact", "ready", "--artifact-id", plan_artifact["id"], "--id", "architect-fixture")
    plan_ready = read_state(state_path)
    assert artifact_by_kind(plan_ready, "architect_plan")["createdBy"] == "architect-fixture"
    cli.run("artifact", "approve", "--artifact-id", plan_artifact["id"], "--id", "user")

    plan_approved = read_state(state_path)
    assert_task_status(plan_approved, plan_task["id"], "done")
    assert_event_type(plan_approved, "artifact_approved")


def test_init_respects_selected_roster_without_a_product_intake_task(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "rostered-team" / "run.yaml"
    cli = SwarmCli(state_path)

    payload = cli.run(
        "init",
        "--goal",
        "Plan with a selected roster",
        "--agent",
        "architect:architect",
        "--agent",
        "developer:developer-1",
    )

    assert payload["ok"] is True
    assert payload["productTask"] is None
    assert payload["planTask"]["role"] == "architect"
    assert payload["planTask"]["dependsOn"] == []

    state = read_state(state_path)
    assert set(state["agents"]) == {"architect", "developer-1"}
    assert_ready_tasks(cli, "architect", [payload["planTask"]["id"]])


def test_architect_cannot_add_tasks_for_roles_absent_from_roster(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "rostered-plan" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--goal",
        "Constrain role planning",
        "--agent",
        "architect:architect",
        "--agent",
        "developer:developer-1",
    )

    rejected = cli.run_failure(
        "plan",
        "add-task",
        "--title",
        "Review performance",
        "--role",
        "performance",
        "--description",
        "Review the implementation.",
    )

    assert "Role 'performance' is not in this Sprint Engine roster" in rejected.stderr

    accepted = cli.run(
        "plan",
        "add-task",
        "--title",
        "Implement scoped work",
        "--role",
        "developer",
        "--description",
        "Build the selected change.",
    )
    assert accepted["task"]["role"] == "developer"


def test_roster_add_allows_later_specialist_tasks(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "roster-expand" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--goal",
        "Expand a selected roster",
        "--agent",
        "architect:architect",
        "--agent",
        "developer:developer-1",
    )

    before = cli.run_failure(
        "plan",
        "add-task",
        "--title",
        "Review security",
        "--role",
        "security",
        "--description",
        "Review the implementation for security risk.",
    )
    assert "Role 'security' is not in this Sprint Engine roster" in before.stderr

    added = cli.run("roster", "add", "--role", "security", "--id", "security", "--actor", "architect")
    assert added["ok"] is True
    assert added["role"] == "security"

    after = cli.run(
        "plan",
        "add-task",
        "--title",
        "Review security",
        "--role",
        "security",
        "--description",
        "Review the implementation for security risk.",
    )
    assert after["task"]["role"] == "security"

    state = read_state(state_path)
    assert state["sprintengine"]["rosterConfigured"] is True
    assert state["agents"]["security"]["role"] == "security"
    assert_event_type(state, "roster_member_added")


def test_temporary_marketer_role_flows_through_core_cli(tmp_path) -> None:
    workspace = tmp_path / "custom-role-workspace"
    write_workspace_role(workspace, "marketer", aliases=["growth-marketer"])
    state_path = workspace / ".multi-code" / "sprintengine" / "custom-role-flow" / "run.yaml"
    cli = SwarmCli(state_path, cwd=workspace)
    cli.run(
        "init",
        "--goal",
        "Use configured custom roles",
        "--agent",
        "architect:architect",
        "--agent",
        "growth-marketer:marketer-1",
    )

    roster = cli.run("roster", "list")
    assert {agent["id"]: agent["role"] for agent in roster["agents"]}["marketer-1"] == "marketer"

    accepted = cli.run(
        "plan",
        "add-task",
        "--title",
        "Draft launch post",
        "--role",
        "growth-marketer",
        "--description",
        "Write the launch post.",
        "--phases",
        "",
    )
    assert accepted["task"]["role"] == "marketer"
    assert accepted["task"]["phases"] == []

    # Planned work roots on the architect plan gate: the marketer task is not
    # claimable until the plan gate completes.
    state = read_state(state_path)
    plan_gate_id = next(t["id"] for t in state["tasks"] if t.get("role") == "architect")
    assert accepted["task"]["dependsOn"] == [plan_gate_id]
    for task in state["tasks"]:
        if task["id"] == plan_gate_id:
            task["status"] = "done"
    store.sync_state_to_store(state_path.parent, state, state_path=state_path)

    listed = cli.run("task", "list", "--role", "growth-marketer")
    assert [task["id"] for task in listed["readyTasks"]] == [accepted["task"]["id"]]

    joined = cli.run("join", "--role", "growth-marketer", "--id", "marketer-1", "--watch", "--max-wait-seconds", "0")
    assert joined["action"] == "work"
    assert "sprintengine task next --role marketer --id marketer-1" in joined["prompt"]

    claimed = cli.run("task", "next", "--role", "growth-marketer", "--id", "marketer-1")
    assert claimed["claimed"] is True
    assert claimed["task"]["role"] == "marketer"
    assert claimed["task"]["id"] == accepted["task"]["id"]


def test_unknown_configured_role_is_rejected_after_argparse(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "unknown-role" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run("init", "--goal", "Reject unknown roles", "--agent", "architect:architect")

    rejected = cli.run_failure("roster", "add", "--role", "not-a-real-role", "--id", "unknown")

    assert "unknown role 'not-a-real-role'" in rejected.stderr
    assert "invalid choice" not in rejected.stderr


def test_plan_review_start_accepts_configured_non_architect_role(tmp_path) -> None:
    fixture = create_workspace_team(tmp_path, "custom-plan-review-workspace", "custom-plan-review-role", [])
    write_workspace_role(fixture.team_dir.parents[2], "release_editor", aliases=["release-editor"])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "editor-1": {"role": "release_editor", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    (fixture.team_dir / "plan.md").write_text("# Plan\n", encoding="utf-8")

    payload = fixture.cli.run("plan", "start-review", "--role", "release-editor", "--id", "editor-1")

    assert payload["role"] == "release_editor"
    assert payload["knownReviewers"] == [{"id": "editor-1", "role": "release_editor"}]
    assert "Review focus: specialist risks, gaps, and execution quality." in payload["prompt"]
    assert (fixture.team_dir / "plan-reviews" / "editor-1.md").is_file()


def test_task_next_returns_active_task_before_claiming_new_work(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "active-task-reuse",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert first["claimed"] is True
    assert first["task"]["id"] == "T1"

    second = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert second["claimed"] is False
    assert second["reason"] == "agent_already_has_active_task"
    assert second["task"]["id"] == "T1"

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "in_progress")
    assert_task_status(state, "T2", "todo")
    assert_board_column(state, "T2", "ready")


def test_active_task_reconnect_and_join_do_not_rewrite_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "active-task-reconnect-no-rewrite",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    next_payload = run_without_state_rewrite(
        fixture,
        "task",
        "next",
        "--role",
        "developer",
        "--id",
        "developer-fixture",
    )
    assert next_payload["claimed"] is False
    assert next_payload["reason"] == "agent_already_has_active_task"
    assert next_payload["task"]["id"] == "T1"

    join_payload = run_without_state_rewrite(
        fixture,
        "join",
        "--role",
        "developer",
        "--id",
        "developer-fixture",
    )
    assert join_payload["action"] == "resume"
    assert join_payload["task"]["id"] == "T1"


def test_join_leaves_an_owned_review_task_with_its_owner(tmp_path) -> None:
    # The stale-owner repair pass only touches terminal tasks. A published task in
    # `review` is owned work in flight: another agent joining must not inherit it,
    # and must not see it as ready.
    review_task = task("T1", "Published, mid review", "frontend", "review", owner="frontend-1")
    fixture = create_team(tmp_path, "owned-review-not-stolen", [review_task])

    other_agent = fixture.cli.run(
        "join",
        "--role",
        "frontend",
        "--id",
        "frontend-2",
        "--watch",
        "--max-wait-seconds",
        "0",
    )
    assert other_agent["action"] == "idle"
    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["ownerAgentId"] == "frontend-1"

    owner = fixture.cli.run(
        "join",
        "--role",
        "frontend",
        "--id",
        "frontend-1",
        "--watch",
        "--max-wait-seconds",
        "0",
    )
    assert owner["action"] == "resume"
    assert owner["task"]["id"] == "T1"

    next_payload = fixture.cli.run("task", "next", "--role", "frontend", "--id", "frontend-2")
    assert next_payload["claimed"] is False
    assert next_payload["reason"] == "no_ready_task"


def test_stale_owner_cleanup_preserves_retired_and_idles_legacy_dead(tmp_path) -> None:
    # Clearing a stale owner claim off a terminal task preserves the one terminal
    # agent status (retired) while a legacy 'dead' id normalizes to idle on load and
    # then has its stale refs cleared like any other non-retired agent.
    stale_task = task("T1", "Already completed", "frontend", "done")
    stale_task["ownerAgentId"] = "frontend-1"
    fixture = create_team(
        tmp_path,
        "stale-owner-terminal-statuses",
        [stale_task, task("T2", "Still to do", "frontend")],
    )
    state = read_state(fixture.state_path)
    state["agents"]["frontend-1"] = {
        "role": "frontend",
        "status": "retired",
        "currentTaskId": "T1",
        "currentDispatch": {"dispatchId": "D1", "targetKind": "task", "role": "frontend", "reason": "task_claimed", "taskId": "T1"},
    }
    state["agents"]["frontend-dead"] = {
        "role": "frontend",
        "status": "dead",
        "currentTaskId": "T1",
        "currentDispatch": {"dispatchId": "D2", "targetKind": "task", "role": "frontend", "reason": "task_claimed", "taskId": "T1"},
    }
    write_state(fixture.state_path, state)

    fixture.cli.run(
        "join",
        "--role",
        "frontend",
        "--id",
        "frontend-2",
        "--watch",
        "--max-wait-seconds",
        "0",
    )

    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["ownerAgentId"] is None
    assert state["agents"]["frontend-1"]["status"] == "retired"
    assert state["agents"]["frontend-1"]["currentTaskId"] is None
    assert state["agents"]["frontend-1"]["currentDispatch"] is None
    assert state["agents"]["frontend-dead"]["status"] == "idle"
    assert state["agents"]["frontend-dead"]["currentTaskId"] is None
    assert state["agents"]["frontend-dead"]["currentDispatch"] is None


def test_join_ready_task_wake_candidate_does_not_create_dispatch(tmp_path) -> None:
    fixture = create_team(tmp_path, "ready-task-wake-candidate", [task("T1", "Implementation", "developer")])

    joined = fixture.cli.run(
        "join",
        "--role",
        "developer",
        "--id",
        "developer-fixture",
        "--watch",
        "--max-wait-seconds",
        "0",
    )

    assert joined["action"] == "work"
    state = read_state(fixture.state_path)
    assert get_task(state, "T1").get("ownerAgentId") in (None, "")
    assert state["agents"]["developer-fixture"]["currentDispatch"] is None
    assert store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl") == []


def test_claimed_task_current_dispatch_is_idempotent(tmp_path) -> None:
    fixture = create_team(tmp_path, "claimed-task-dispatch-idempotent", [task("T1", "Implementation", "developer")])

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    resumed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert claimed["claimed"] is True
    assert resumed["claimed"] is False
    assert resumed["reason"] == "agent_already_has_active_task"
    run = store.load_run_yaml(fixture.team_dir)
    dispatches = [
        record
        for record in store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
        if record["reason"] == "task_claimed"
    ]
    assert len(dispatches) == 1
    assert run["agents"]["developer-fixture"]["currentDispatch"]["dispatchId"] == dispatches[0]["id"]
    assert run["agents"]["developer-fixture"]["currentDispatch"]["taskId"] == "T1"


def test_a_published_task_records_no_second_dispatch(tmp_path) -> None:
    # Publishing does not hand the task to anyone: no reviewer dispatch is
    # queued, and the owner's `task_claimed` dispatch is still the only one.
    fixture = create_team(tmp_path, "publish-no-second-dispatch", [task("T1", "Implementation", "developer")])

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    published = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Ready for my own review.")
    assert published["nextStatus"] == "review"

    run = store.load_run_yaml(fixture.team_dir)
    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
    assert [record["reason"] for record in dispatches] == ["task_claimed"]
    assert run["agents"]["developer-fixture"]["currentDispatch"]["reason"] == "task_claimed"
    assert run["agents"]["developer-fixture"]["currentDispatch"]["targetKind"] == "task"
    assert run["agents"]["developer-fixture"]["currentTaskId"] == "T1"

    projection = fixture.cli.run("projection")
    assert projection["roster"]["developer-fixture"]["currentDispatch"]["reason"] == "task_claimed"
    # The advance that completes the task queues no dispatch either.
    fixture.cli.run(
        "task", "advance", "--task-id", "T1", "--id", "developer-fixture",
        "--phase", "review", "--outcome", "pass", "--summary", "Reviewed.",
    )
    assert len(store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")) == 1


def test_ready_task_dispatch_rotates_after_released_target(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "round-robin-task-dispatch",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert first["task"]["id"] == "T1"

    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "todo", "--id", "developer-1")

    second = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert second["task"]["id"] == "T2"

    state = read_state(fixture.state_path)
    assert state["sprintengine"]["dispatchCursors"]["developer:task"] == "task:T2"


def test_expired_agent_releases_task_and_redispatches_with_ledger_evidence(tmp_path) -> None:
    fixture = create_team(tmp_path, "expired-agent-task-release", [task("T1", "Implementation", "developer")])
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    state = read_state(fixture.state_path)
    state["sprintengine"]["agentTimeoutSeconds"] = 1
    state["agents"]["developer-1"]["heartbeatAt"] = "2000-01-01T00:00:00Z"
    write_state(fixture.state_path, state)

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert claimed["task"]["id"] == "T1"
    assert claimed["releasedExpired"][0]["agentId"] == "developer-1"

    state = read_state(fixture.state_path)
    # Derived liveness: the expired agent is released to idle-no-target, not
    # stamped with a stored terminal status.
    assert state["agents"]["developer-1"]["status"] == "idle"
    assert state["agents"]["developer-2"]["currentTaskId"] == "T1"
    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
    assert any(record["reason"] == "agent_expired_release" for record in dispatches)
    assert any(event["type"] == "agent_targets_released" for event in state["events"])


def test_expired_agent_released_to_idle_reflects_in_projection(tmp_path) -> None:
    # Derived liveness: an expired worker is released to idle-no-target (no stored
    # terminal status), its task freed and re-dispatched, and the projection
    # roster reflects the idle-no-target reset.
    fixture = create_team(tmp_path, "expired-agent-task-idle", [task("T1", "Implementation", "developer")])
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    state = read_state(fixture.state_path)
    state["sprintengine"]["agentTimeoutSeconds"] = 1
    state["agents"]["developer-1"]["heartbeatAt"] = "2000-01-01T00:00:00Z"
    write_state(fixture.state_path, state)

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert claimed["task"]["id"] == "T1"
    assert claimed["releasedExpired"][0]["agentId"] == "developer-1"

    state = read_state(fixture.state_path)
    departed = state["agents"]["developer-1"]
    assert departed["status"] == "idle"
    assert departed["currentTaskId"] is None
    assert departed["currentDispatch"] is None
    assert state["agents"]["developer-2"]["currentTaskId"] == "T1"
    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
    assert any(record["reason"] == "agent_expired_release" and record["agentId"] == "developer-1" for record in dispatches)
    # Gate claims are gone: an agent record never carries a gate mirror.
    assert "currentGateId" not in departed
    assert "currentGate" not in departed
    projection = fixture.cli.run("projection")
    assert projection["roster"]["developer-1"]["status"] == "idle"
    assert projection["roster"]["developer-1"]["currentTaskId"] is None
    assert projection["roster"]["developer-1"]["currentDispatch"] is None


def test_expired_owner_of_a_review_task_keeps_the_task(tmp_path) -> None:
    # The expiry sweep uses the same release authority as agent.leave, so it frees
    # `in_progress` work only. A published task keeps its owner and never becomes
    # claimable by a fresh id — the owner is revived under the same id instead.
    fixture = create_team(tmp_path, "expired-review-owner", [task("T1", "Implementation", "developer")])
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Ready for my review.")

    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["status"] == "review"
    state["sprintengine"]["agentTimeoutSeconds"] = 1
    state["agents"]["developer-1"]["heartbeatAt"] = "2000-01-01T00:00:00Z"
    write_state(fixture.state_path, state)

    refused = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert refused["claimed"] is False
    assert refused["reason"] == "no_ready_task"
    assert refused["releasedExpired"] == []

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "review"
    assert task_record["ownerAgentId"] == "developer-1"


def test_completed_agent_ids_cannot_recycle_onto_a_second_task(tmp_path) -> None:
    # Task-scoped roster ids never recycle: once developer-fixture owns T1 it is
    # spent, and the per_task claim guard refuses its claim on a different ready
    # task (T2). A fresh id must take T2.
    fixture = create_team(
        tmp_path,
        "completed-agent-no-reuse",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    # No review step: publish is the whole walk, so T1 completes in one call.
    state["defaultPhases"] = []
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Completed the first task.",
        "--file",
        "tests/sprintengine_tool/test_task_lifecycle.py",
        "--command",
        "pytest tests/sprintengine_tool/test_task_lifecycle.py",
        "--result",
        "Passed",
    )
    published = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Shipped T1.")
    assert published["nextStatus"] == "done"

    refused = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert refused["claimed"] is False
    assert refused["reason"] == "worker_task_capacity_reached"

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert_task_status(state, "T2", "todo")

    # A fresh task-scoped id claims T2.
    fresh = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert fresh["claimed"] is True
    assert fresh["task"]["id"] == "T2"
    state = read_state(fixture.state_path)
    assert_task_status(state, "T2", "in_progress")


def test_retired_agent_ids_cannot_claim_more_work(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "retired-agent-no-reuse",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    state["defaultPhases"] = []
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Completed the first task.",
        "--file",
        "tests/sprintengine_tool/test_task_lifecycle.py",
        "--command",
        "pytest tests/sprintengine_tool/test_task_lifecycle.py",
        "--result",
        "Passed",
    )
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Shipped T1.")

    retired = fixture.cli.run(
        "roster",
        "retire",
        "--id",
        "developer-fixture",
        "--reason",
        "context capacity near limit",
    )
    assert retired["action"] == "retired"
    assert retired["agent"]["status"] == "retired"

    join_payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-fixture")
    assert join_payload["action"] == "retired"

    rejected = fixture.cli.run_failure("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert "is retired and cannot claim more Sprint Engine work" in rejected.stderr

    state = read_state(fixture.state_path)
    assert state["agents"]["developer-fixture"]["status"] == "retired"
    assert_task_status(state, "T2", "todo")
    assert_event_type(state, "roster_member_retired")


def test_roster_replenish_adds_replacement_for_retired_capacity_with_open_work(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "retired-agent-replenish",
        [
            task("T1", "Completed implementation", "developer", "done"),
            task("T2", "Remaining implementation", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "developer-1": {
            "role": "developer",
            "status": "retired",
            "currentTaskId": None,
            "retiredAt": "2026-05-19T00:00:00Z",
            "retiredReason": "context capacity near limit",
        }
    }
    state["sprintengine"]["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    replenished = fixture.cli.run("roster", "replenish", "--role", "developer", "--actor", "runner")
    assert replenished["action"] == "replenished"
    assert replenished["created"][0]["id"] == "developer-2"

    next_payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert next_payload["claimed"] is True
    assert next_payload["task"]["id"] == "T2"

    state = read_state(fixture.state_path)
    assert state["agents"]["developer-1"]["replacedByAgentId"] == "developer-2"
    assert state["agents"]["developer-2"]["status"] == "running"
    assert_event_type(state, "roster_replacement_added")


def test_roster_replenish_skips_singleton_role_while_seat_is_occupied(tmp_path) -> None:
    # 2026-07-14 starvation regression: retired planners never carry
    # replacedByAgentId when their successor was seated manually, so the
    # retired-replacement pass tried to mint architect-4 into an occupied
    # singleton seat, SystemExit'd the whole command every supervisor tick, and
    # the tick abort starved dispatch for every role. The occupied seat IS the
    # replacement; replenish must succeed as a no-op for that role.
    fixture = create_team(
        tmp_path,
        "occupied-singleton-replenish",
        [
            task("T0", "Plan approval", "architect", "done"),
            task("T1", "Follow-up planning", "architect"),
        ],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "architect": {"role": "architect", "status": "retired", "currentTaskId": None, "lastOwnedTaskId": "T0"},
        "architect-2": {"role": "architect", "status": "retired", "currentTaskId": None},
        "architect-3": {"role": "architect", "status": "idle", "currentTaskId": None},
    }
    state["sprintengine"]["rosterConfigured"] = True
    state["configuredRoles"] = ["architect", "developer"]
    write_state(fixture.state_path, state)

    replenished = fixture.cli.run("roster", "replenish", "--actor", "runner")
    assert replenished["action"] == "none"
    state = read_state(fixture.state_path)
    assert set(agent_id for agent_id in state["agents"]) == {"architect", "architect-2", "architect-3"}


def test_roster_replenish_mints_one_replacement_for_a_vacated_singleton_seat(tmp_path) -> None:
    # Two unreplaced retirees + a vacated seat: exactly one replacement seats
    # (filling the singleton seat); a second mint would trip the seat cap
    # mid-loop and fail the command.
    fixture = create_team(
        tmp_path,
        "vacated-singleton-replenish",
        [
            task("T0", "Plan approval", "architect", "done"),
            task("T1", "Follow-up planning", "architect"),
        ],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "architect": {"role": "architect", "status": "retired", "currentTaskId": None},
        "architect-2": {"role": "architect", "status": "retired", "currentTaskId": None},
    }
    state["sprintengine"]["rosterConfigured"] = True
    state["configuredRoles"] = ["architect", "developer"]
    write_state(fixture.state_path, state)

    replenished = fixture.cli.run("roster", "replenish", "--actor", "runner")
    assert replenished["action"] == "replenished"
    assert [entry["role"] for entry in replenished["created"]] == ["architect"]
    state = read_state(fixture.state_path)
    architects_alive = [
        agent_id
        for agent_id, agent in state["agents"].items()
        if agent.get("role") == "architect" and agent.get("status") != "retired"
    ]
    assert len(architects_alive) == 1


def test_roster_replenish_queue_depth_tops_up_task_scoped_capacity(tmp_path) -> None:
    # MC-1444 Phase 3: with one agent session per task, a role's parallel
    # throughput is bounded by spawnable roster ids. Three ready developer
    # tasks against zero capacity (the only id is bound to its in-window task)
    # mints up to --max-new ids; repeat runs converge instead of growing.
    fixture = create_team(
        tmp_path,
        "queue-depth-replenish",
        [
            task("T0", "Published implementation", "developer", "review"),
            task("T1", "Ready one", "developer"),
            task("T2", "Ready two", "developer"),
            task("T3", "Ready three", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        # Bound to its publish→verdict task: not capacity for new work.
        "developer-1": {"role": "developer", "status": "idle", "currentTaskId": None, "lastOwnedTaskId": "T0"},
    }
    state["sprintengine"]["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    replenished = fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "2")
    assert replenished["action"] == "replenished"
    assert [entry["id"] for entry in replenished["created"]] == ["developer-2", "developer-3"]
    assert all(entry.get("reason") == "queue_depth" for entry in replenished["created"])
    state = read_state(fixture.state_path)
    assert_event_type(state, "roster_capacity_added")

    # The minted ids now count as capacity: only the remaining deficit mints.
    replenished_again = fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "5")
    assert [entry["id"] for entry in replenished_again["created"]] == ["developer-4"]

    # Fully covered: converges to none.
    assert fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "5")["action"] == "none"

    # Without --queue-depth the legacy retired-replacement behavior is
    # untouched (no retired agents here, so nothing mints).
    assert fixture.cli.run("roster", "replenish", "--actor", "runner")["action"] == "none"


def test_roster_replenish_queue_depth_capacity_excludes_spent_busy_and_done(tmp_path) -> None:
    # Task-scoped capacity: an id that has EVER owned a task is spent — not
    # capacity for new work, even after that task is done and even when 'left'
    # (no recycling). Only a never-owned idle id counts. Busy (renderer-reported)
    # and run-complete 'done' ids never count. The op returns task-paired
    # assignments for each fresh mint.
    fixture = create_team(
        tmp_path,
        "queue-depth-capacity",
        [
            task("T0", "Finished work", "developer", "done"),
            task("T1", "Ready one", "developer"),
            task("T2", "Ready two", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        # spent left id (owned T0): no longer capacity — a fresh id takes new work.
        "developer-1": {"role": "developer", "status": "left", "currentTaskId": None, "lastOwnedTaskId": "T0"},
        # never-owned idle id: the one real unit of capacity — absorbs T1.
        "developer-2": {"role": "developer", "status": "idle", "currentTaskId": None},
        # busy live terminal (renderer-reported): must NOT count.
        "developer-3": {"role": "developer", "status": "idle", "currentTaskId": None},
        # run-complete marker status: must NOT count.
        "developer-4": {"role": "developer", "status": "done", "currentTaskId": None},
    }
    state["sprintengine"]["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    replenished = fixture.cli.run(
        "roster", "replenish", "--actor", "runner",
        "--queue-depth", "--max-new", "5",
        "--busy-agent", "developer-3",
    )
    # Depth 2 (T1,T2) vs capacity 1 (developer-2 only) -> mint exactly one for T2.
    assert [entry["id"] for entry in replenished["created"]] == ["developer-5"]
    assert replenished["assignments"] == [{"agentId": "developer-5", "role": "developer", "taskId": "T2"}]


def test_roster_replenish_combined_retired_and_queue_depth_passes_do_not_double_mint(tmp_path) -> None:
    # The queue-depth pass runs AFTER the retired-replacement pass so freshly
    # minted replacements count as capacity (explicit invariant in roster.py).
    fixture = create_team(
        tmp_path,
        "queue-depth-combined",
        [
            task("T1", "Ready one", "developer"),
            task("T2", "Ready two", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "developer-1": {
            "role": "developer",
            "status": "retired",
            "currentTaskId": None,
            "retiredAt": "2026-07-02T00:00:00Z",
            "retiredReason": "context capacity near limit",
        },
    }
    state["sprintengine"]["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    replenished = fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "5")
    created = replenished["created"]
    # Retired pass mints developer-2 (replacement); queue-depth then sees
    # depth 2 vs capacity 1 and mints exactly one more — not two.
    assert [entry["id"] for entry in created] == ["developer-2", "developer-3"]
    assert created[0].get("replaces") == ["developer-1"]
    assert created[1].get("reason") == "queue_depth"


def test_roster_replenish_queue_depth_skips_in_flight_work_and_planning_roles(tmp_path) -> None:
    # A task in `review` is owned by its implementer for the rest of its walk, so
    # it is neither ready work nor a deficit — no surplus id is minted for it.
    # Planning roles never mint parallel capacity either.
    fixture = create_team(
        tmp_path,
        "queue-depth-covered",
        [
            task("T1", "Published, mid review", "developer", "review", owner="developer-1"),
            task("G1", "General-owned work", "general"),
        ],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        # No general agent at all: the ready G1 task would show a deficit, but
        # planning roles are skipped — a General owns a whole sprint solo.
        "developer-1": {"role": "developer", "status": "running", "currentTaskId": "T1", "lastOwnedTaskId": "T1"},
    }
    state["sprintengine"]["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    assert fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "5")["action"] == "none"


def test_auto_mode_retire_immediately_adds_replacement_for_open_work(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "retired-agent-auto-replenish",
        [
            task("T1", "Completed implementation", "developer", "done"),
            task("T2", "Remaining implementation", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    state["runner"] = {"cliWatchPolling": "enabled"}
    state["agents"] = {
        "developer-1": {
            "role": "developer",
            "status": "idle",
            "currentTaskId": None,
        }
    }
    state["sprintengine"]["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    retired = fixture.cli.run(
        "roster",
        "retire",
        "--id",
        "developer-1",
        "--reason",
        "context capacity near limit",
    )
    assert retired["action"] == "retired"
    assert retired["replacement"]["id"] == "developer-2"

    next_payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert next_payload["claimed"] is True
    assert next_payload["task"]["id"] == "T2"

    state = read_state(fixture.state_path)
    assert state["agents"]["developer-1"]["status"] == "retired"
    assert state["agents"]["developer-1"]["replacedByAgentId"] == "developer-2"
    assert state["agents"]["developer-2"]["status"] == "running"
    assert_event_type(state, "roster_member_retired")
    assert_event_type(state, "roster_replacement_added")

    second = fixture.cli.run("roster", "replenish", "--role", "developer", "--actor", "runner")
    assert second["action"] == "none"


def test_roster_replenish_preserves_multi_agent_role_capacity(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "retired-agent-replenish-capacity",
        [task("T1", "Remaining implementation", "developer")],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "developer-1": {
            "role": "developer",
            "status": "retired",
            "currentTaskId": None,
            "retiredAt": "2026-05-19T00:00:00Z",
            "retiredReason": "context capacity near limit",
        },
        "developer-2": {
            "role": "developer",
            "status": "idle",
            "currentTaskId": None,
        },
    }
    state["sprintengine"]["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    replenished = fixture.cli.run("roster", "replenish", "--role", "developer", "--actor", "runner")
    assert replenished["action"] == "replenished"
    assert replenished["created"][0]["id"] == "developer-3"

    second = fixture.cli.run("roster", "replenish", "--role", "developer", "--actor", "runner")
    assert second["action"] == "none"

    state = read_state(fixture.state_path)
    assert state["agents"]["developer-1"]["replacedByAgentId"] == "developer-3"
    assert state["agents"]["developer-2"]["status"] == "idle"
    assert state["agents"]["developer-3"]["status"] == "idle"


def test_roster_retire_rejects_active_task_owner(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "retire-active-task-rejected",
        [task("T1", "Active implementation", "developer")],
    )

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    rejected = fixture.cli.run_failure(
        "roster",
        "retire",
        "--id",
        "developer-fixture",
        "--reason",
        "context capacity near limit",
    )
    assert "still owns active task" in rejected.stderr


def test_task_claiming_is_restricted_to_the_requested_role(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "role-restricted-next",
        [
            task("T1", "Developer implementation", "developer"),
            task("T2", "Tester validation", "tester", depends_on=["T1"]),
        ],
    )

    wrong_role = fixture.cli.run("task", "next", "--role", "tester", "--id", "tester-fixture")
    assert wrong_role["claimed"] is False
    assert wrong_role["reason"] == "no_ready_task"

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "todo")
    assert_task_status(state, "T2", "todo")
    assert_ready_tasks(fixture.cli, "developer", ["T1"])


def test_task_log_records_evidence_without_changing_lifecycle_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-evidence",
        [task("T1", "Implementation with evidence", "developer", "in_progress", owner="developer-fixture")],
    )

    payload = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Encoded task lifecycle regressions.",
        "--file",
        "tests/sprintengine_tool/test_task_lifecycle.py",
        "--command",
        "pytest tests/sprintengine_tool/test_task_lifecycle.py",
        "--result",
        "Passed",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert_task_status(state, "T1", "in_progress")
    assert task_record["evidence"] == {
        "summary": "Encoded task lifecycle regressions.",
        "touchedFiles": ["tests/sprintengine_tool/test_task_lifecycle.py"],
        "commandsRan": ["pytest tests/sprintengine_tool/test_task_lifecycle.py"],
        "results": ["Passed"],
        "scopeExpansions": [],
    }
    assert_event_type(state, "task_evidence_appended")


def test_task_log_records_scope_expansions_and_summary_surfaces_them(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-scope-expansion",
        [
            task(
                "T1",
                "Implementation with companion test",
                "developer",
                "in_progress",
                owner="developer-fixture",
                owned_paths=["sprintengine_core/tool.py"],
            )
        ],
    )
    state = read_state(fixture.state_path)
    state["defaultPhases"] = []
    write_state(fixture.state_path, state)

    payload = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Added companion regression coverage.",
        "--file",
        "sprintengine_core/tool.py",
        "--file",
        "tests/sprintengine_tool/test_task_lifecycle.py",
        "--scope-expansion-json",
        '{"path":"tests/sprintengine_tool/test_task_lifecycle.py","reason":"colocated regression coverage for task log evidence","risk":"low; test-only"}',
    )
    assert payload["ok"] is True

    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Shipped with companion test.")

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["evidence"]["scopeExpansions"] == [
        {
            "path": "tests/sprintengine_tool/test_task_lifecycle.py",
            "reason": "colocated regression coverage for task log evidence",
            "risk": "low; test-only",
        }
    ]
    summary = fixture.cli.run("summary")["summary"]
    assert summary["scopeExpansions"] == [
        {
            "taskId": "T1",
            "path": "tests/sprintengine_tool/test_task_lifecycle.py",
            "reason": "colocated regression coverage for task log evidence",
            "risk": "low; test-only",
        }
    ]


def test_task_log_rejects_absolute_scope_expansion_path(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-scope-expansion-absolute",
        [task("T1", "Invalid companion edit path", "developer", "in_progress", owner="developer-fixture")],
    )

    rejected = fixture.cli.run_failure(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--scope-expansion-json",
        '{"path":"/tmp/outside.py","reason":"bad absolute path"}',
    )

    assert "must use project-root-relative paths" in rejected.stderr
