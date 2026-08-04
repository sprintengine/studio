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


def worker_view(fixture, worker_id: str) -> dict:
    """The worker's lease-derived projection view (MC-1591: no agents map).

    An absent worker holds no active lease and no implementer stamp, which is the
    lease model's equivalent of the old idle/unclaimed agent record — default to
    that shape so callers can assert status/currentTaskId uniformly.
    """
    projection = store.build_projection(fixture.team_dir, state_path=fixture.state_path)
    return projection["workers"].get(worker_id) or {"status": "idle", "currentTaskId": None}


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
    joined = fixture.cli.run("join", "--role", "developer", "--id", "developer-fixture")
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
    fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled")

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
    assert "nextCommand" not in payload
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
    assert worker_view(fixture, "developer-fixture")["currentTaskId"] == "T1"


def test_task_advance_out_of_review_completes_the_task(tmp_path) -> None:
    fixture = create_team(tmp_path, "advance-completes", [owned_task()])
    fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled")
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
    assert "nextCommand" not in payload
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "done"
    assert task_record["completedAt"]
    assert task_record["ownerAgentId"] is None
    assert worker_view(fixture, "developer-fixture")["status"] == "idle"
    assert_event_type(state, "task_phase_advanced")


def test_task_publish_is_owner_only_across_two_concurrent_agents(tmp_path) -> None:
    """MC-2072: the shape that could not occur before roleless runs minted a second agent.

    Two agents, two tasks, one run, both `in_progress` at once. Agent 2 publishing
    agent 1's task used to land it in `review` with `ownerAgentId=developer-2` —
    the real owner lost its task mid-flight with no signal.
    """
    fixture = create_team(
        tmp_path,
        "publish-cross-agent",
        [
            task("T1", "Agent one's work", "developer", "in_progress", owner="developer-1"),
            task("T2", "Agent two's work", "developer", "in_progress", owner="developer-2"),
        ],
    )

    stolen = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T1", "--id", "developer-2", "--summary", "Publishing your task.",
    )
    assert "not_task_owner" in stolen.stderr

    # Neither the status nor the owner moved.
    state = read_state(fixture.state_path)
    stolen_task = get_task(state, "T1")
    assert stolen_task["status"] == "in_progress"
    assert stolen_task["ownerAgentId"] == "developer-1"

    # And each owner's own publish still works.
    assert fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Mine.",
    )["nextStatus"]
    assert fixture.cli.run(
        "task", "publish", "--task-id", "T2", "--id", "developer-2", "--summary", "Also mine.",
    )["nextStatus"]


def test_task_publish_on_an_unowned_task_is_refused(tmp_path) -> None:
    """A publish with no recorded owner must refuse, not silently claim."""
    fixture = create_team(tmp_path, "publish-unowned", [owned_task(owner=None)])

    refused = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Claiming by publish.",
    )
    assert "not_task_owner" in refused.stderr
    assert_task_status(read_state(fixture.state_path), "T1", "in_progress")


def test_task_status_refuses_a_peer_worker_but_not_the_coordinator(tmp_path) -> None:
    """MC-2072 audit: `task.status --status done` stamps the implementer and commits.

    Same takeover as publish, reachable from the same agent tool surface. The two
    sanctioned overrides stay open: the coordinator's triage seat and the human
    Inbox send-back.
    """
    fixture = create_team(
        tmp_path,
        "status-cross-agent",
        [
            task("T1", "Agent one's work", "developer", "in_progress", owner="developer-1"),
            task("T2", "Agent two's work", "developer", "in_progress", owner="developer-2"),
        ],
    )

    stolen = fixture.cli.run_failure(
        "task", "status", "--task-id", "T1", "--id", "developer-2", "--status", "done",
    )
    assert "not_task_owner" in stolen.stderr
    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["status"] == "in_progress"
    assert get_task(state, "T1")["ownerAgentId"] == "developer-1"
    assert not get_task(state, "T1").get("lastImplementedByAgentId")

    # The coordinator seat still triages any task in the run.
    fixture.cli.run("task", "status", "--task-id", "T1", "--id", "architect", "--status", "todo")
    assert_task_status(read_state(fixture.state_path), "T1", "todo")


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
    # The analysis-only exit — now EXPLICIT (MC-1753): change
    # detection finds no diff, and completion requires --no-changes-ok. Without
    # it the publish is rejected (a silent no-op completion is how work stranded
    # in the wrong tree once passed unnoticed); with it, every phase is skipped,
    # the task lands on done, and the exit is durably marked.
    init_git_repo(tmp_path)
    commit_file(tmp_path, "src/untouched.py", "value = 1\n")
    record = owned_task()
    record["ownedPaths"] = ["src/untouched.py"]
    fixture = create_team(tmp_path, "publish-no-changes", [record])

    rejected = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Swept; nothing to change.",
    )
    assert "No committed changes" in rejected.stderr
    assert "--no-changes-ok" in rejected.stderr

    payload = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-fixture",
        "--summary", "Swept; nothing to change.", "--no-changes-ok",
    )

    assert payload["producedChanges"] is False
    assert payload["nextStatus"] == "done"
    assert payload["phases"] == []
    assert payload["completionKind"] == "no_changes"
    assert payload["feedbackRecorded"] is True
    final_state = read_state(fixture.state_path)
    assert_task_status(final_state, "T1", "done")
    task_record = get_task(final_state, "T1")
    assert task_record["completedAt"]
    assert task_record["completionKind"] == "no_changes"


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

    payload = fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled", "--poll-interval-seconds", "2", "--idle-backoff-seconds", "3")

    assert payload["runner"]["cliWatchPolling"] == "enabled"
    assert payload["runner"]["pollIntervalSeconds"] == 2
    state = read_state(fixture.state_path)
    assert state["runner"]["cliWatchPolling"] == "enabled"
    projection = fixture.cli.run("projection")
    assert projection["run"]["runner"]["cliWatchPolling"] == "enabled"

    off_payload = fixture.cli.run("runner", "set", "--cli-watch-polling", "disabled")
    assert off_payload["runner"]["cliWatchPolling"] == "disabled"
    assert read_state(fixture.state_path)["runner"]["cliWatchPolling"] == "disabled"


def test_join_returns_idle_once_when_no_work_is_ready_for_the_role(tmp_path) -> None:
    # Join is one-shot (MC-1827): with another role's work queued it reports idle
    # and returns, whatever the runner policy says. Nothing polls.
    fixture = create_team(tmp_path, "join-idle", [task("T1", "Frontend work", "frontend", "todo")])
    fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled")

    payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-1")

    assert payload["action"] == "idle"
    assert payload["message"] == "No tasks are currently ready for the 'developer' role."
    assert "watch" not in payload


def test_join_reports_completion_when_every_task_is_terminal(tmp_path) -> None:
    # The run already reached `completed` through recompute_phase; join only says
    # so. It runs no backstop commit and opens no pull request.
    fixture = create_team(
        tmp_path,
        "join-complete",
        [task("T1", "Done work", "developer", "done"), task("T2", "Dropped work", "frontend", "canceled")],
    )

    payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-1")

    assert payload["action"] == "complete"
    assert payload["message"] == "All Sprint Engine tasks are done. Stop now."


def test_join_resumes_an_owner_parked_in_its_review_phase(tmp_path) -> None:
    # `review` is owned, so its owner reconnects to it rather than being offered
    # the ready task queued behind it. A stranger sees no ready work at all.
    review_task = owned_task("review", owner="developer-fixture")
    fixture = create_team(tmp_path, "join-review-resume", [review_task])
    fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled")

    owner = fixture.cli.run("join", "--role", "developer", "--id", "developer-fixture")
    stranger = fixture.cli.run("join", "--role", "developer", "--id", "developer-2")

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


def test_join_routes_architect_needs_input_before_ready_task(tmp_path) -> None:
    blocked = task("T1", "Needs architect decision", "developer", "needs_input", owner="developer-1")
    blocked["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Should this task own the shared contract?",
    }
    ready_architect = task("T2", "Architect normal task", "architect")
    fixture = create_team(tmp_path, "join-architect-triage", [blocked, ready_architect])
    fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled")

    payload = fixture.cli.run("join", "--role", "architect", "--id", "architect")

    assert payload["action"] == "needs_input_triage"
    assert "triage needs-input" in payload["prompt"]


def test_join_stops_owner_on_unresolved_needs_input(tmp_path) -> None:
    blocked = task("T1", "Needs product decision", "developer", "needs_input", owner="developer-1")
    blocked["needsInput"] = {
        "kind": "user",
        "reason": "product_decision",
        "question": "Which export format should ship?",
        "reportedBy": "developer-1",
        "reportedAt": "2026-05-25T00:00:00Z",
    }
    fixture = create_team(tmp_path, "join-owner-needs-input-stops", [blocked])
    fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled")

    payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-1")

    assert payload["action"] == "blocked"
    assert payload["blocker"]["reason"] == "needs_input"
    assert payload["blocker"]["kind"] == "user"
    assert "Stop until the blocker is resolved" in payload["message"]


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

    # Completing straight out of `review` is allowed too, and the ack never
    # carries a continuation command — the worker stops (MC-1827).
    fixture = create_team(
        tmp_path,
        "status-done-auto-mode",
        [task("T1", "Completed from review", "developer", "review", owner="developer-fixture")],
    )
    fixture.cli.run("runner", "set", "--cli-watch-polling", "enabled")

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    assert payload["ok"] is True
    assert "nextCommand" not in payload
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
        assert worker_view(fixture, "developer-fixture")["currentTaskId"] == "T1"


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
    # Released to the queue, frontend-1 holds no active lease: its worker view is
    # the idle default (no current task).
    assert worker_view(fixture, "frontend-1")["status"] == "idle"
    assert worker_view(fixture, "frontend-1")["currentTaskId"] is None
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
    assert worker_view(fixture, "frontend-1")["status"] == "running"
    assert worker_view(fixture, "frontend-1")["currentTaskId"] == "T1"
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
    # Done -> the lease ended, so developer-1 runs nothing (idle worker view).
    assert worker_view(fixture, "developer-1")["currentTaskId"] is None
    assert worker_view(fixture, "developer-1")["status"] == "idle"
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
    assert worker_view(fixture, "frontend-1")["status"] == "idle"
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
    # `--agent` marks the run roster-configured; leases dropped the agents map, so
    # there is no seated set to assert. The plan gate is the architect's.
    assert state["sprintengine"]["rosterConfigured"] is True
    assert_ready_tasks(cli, "architect", [payload["planTask"]["id"]])


def test_architect_cannot_add_tasks_for_roles_absent_from_roster(tmp_path) -> None:
    # The role boundary is `configuredRoles` now (leases dropped the seated
    # roster): a task role outside the enabled set is refused, an enabled one
    # accepted — with zero live workers of that role (the lazy roster).
    state_path = tmp_path / ".multi-code" / "sprintengine" / "rostered-plan" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--goal",
        "Constrain role planning",
        "--agent",
        "architect:architect",
        "--configured-roles-json",
        '["architect", "developer"]',
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

    assert "Role 'performance' is not enabled for this run" in rejected.stderr

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

    # The `growth-marketer` alias resolves to the `marketer` role (leases dropped
    # `roster list`; the resolution is proven by the planned task's role below).
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

    joined = cli.run("join", "--role", "growth-marketer", "--id", "marketer-1")
    assert joined["action"] == "work"
    assert "sprintengine task next --role marketer --id marketer-1" in joined["prompt"]

    claimed = cli.run("task", "next", "--role", "growth-marketer", "--id", "marketer-1")
    assert claimed["claimed"] is True
    assert claimed["task"]["role"] == "marketer"
    assert claimed["task"]["id"] == accepted["task"]["id"]


def test_unknown_role_is_rejected_by_the_registry_not_argparse(tmp_path) -> None:
    # The CLI accepts any --role string and validates it against the role registry
    # itself (require_configured_role), so an unknown role is a clean registry
    # error, never an argparse "invalid choice".
    state_path = tmp_path / ".multi-code" / "sprintengine" / "unknown-role" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run("init", "--goal", "Reject unknown roles", "--agent", "architect:architect")

    rejected = cli.run_failure(
        "plan", "add-task", "--title", "X", "--role", "not-a-real-role", "--description", "d",
    )

    assert "unknown role 'not-a-real-role'" in rejected.stderr
    assert "invalid choice" not in rejected.stderr


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
    )
    assert owner["action"] == "resume"
    assert owner["task"]["id"] == "T1"

    next_payload = fixture.cli.run("task", "next", "--role", "frontend", "--id", "frontend-2")
    assert next_payload["claimed"] is False
    assert next_payload["reason"] == "no_ready_task"


def test_join_ready_task_wake_candidate_does_not_create_dispatch(tmp_path) -> None:
    fixture = create_team(tmp_path, "ready-task-wake-candidate", [task("T1", "Implementation", "developer")])

    joined = fixture.cli.run(
        "join",
        "--role",
        "developer",
        "--id",
        "developer-fixture",
    )

    assert joined["action"] == "work"
    state = read_state(fixture.state_path)
    assert get_task(state, "T1").get("ownerAgentId") in (None, "")
    # The wake candidate did not claim, so it holds no lease and appears in no
    # worker view, and no dispatch record was appended.
    assert "developer-fixture" not in store.build_projection(fixture.team_dir, state_path=fixture.state_path)["workers"]
    assert store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl") == []


def test_claimed_task_records_single_dispatch_and_is_idempotent(tmp_path) -> None:
    # MC-1591: the per-agent dispatch cursor is gone; the lease on the task record
    # is the claim authority. A re-claim resumes the active task (idempotent) and
    # appends no second `task_claimed` ledger record.
    fixture = create_team(tmp_path, "claimed-task-dispatch-idempotent", [task("T1", "Implementation", "developer")])

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    resumed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert claimed["claimed"] is True
    assert resumed["claimed"] is False
    assert resumed["reason"] == "agent_already_has_active_task"
    dispatches = [
        record
        for record in store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
        if record["reason"] == "task_claimed"
    ]
    assert len(dispatches) == 1
    assert dispatches[0]["agentId"] == "developer-fixture"
    assert dispatches[0]["target"]["taskId"] == "T1"


def test_a_published_task_records_no_second_dispatch(tmp_path) -> None:
    # Publishing does not hand the task to anyone: no reviewer dispatch is
    # queued, and the owner's `task_claimed` dispatch is still the only one.
    fixture = create_team(tmp_path, "publish-no-second-dispatch", [task("T1", "Implementation", "developer")])

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    published = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Ready for my own review.")
    assert published["nextStatus"] == "review"

    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
    assert [record["reason"] for record in dispatches] == ["task_claimed"]
    assert dispatches[0]["target"]["taskId"] == "T1"
    assert worker_view(fixture, "developer-fixture")["currentTaskId"] == "T1"

    # The advance that completes the task queues no dispatch either.
    fixture.cli.run(
        "task", "advance", "--task-id", "T1", "--id", "developer-fixture",
        "--phase", "review", "--outcome", "pass", "--summary", "Reviewed.",
    )
    assert len(store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")) == 1


def test_distinct_workers_claim_distinct_ready_tasks(tmp_path) -> None:
    # MC-1591 replaced round-robin dispatch cursors with leases. Two ready tasks
    # go to two distinct workers: the first holds T1's lease, so the second worker
    # takes the next ready task rather than a re-hand of T1, and no cursor state
    # is persisted.
    fixture = create_team(
        tmp_path,
        "distinct-worker-claims",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert first["task"]["id"] == "T1"

    second = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert second["task"]["id"] == "T2"

    state = read_state(fixture.state_path)
    assert "dispatchCursors" not in state.get("sprintengine", {})


def test_expired_agent_releases_task_and_redispatches_with_ledger_evidence(tmp_path) -> None:
    fixture = create_team(tmp_path, "expired-agent-task-release", [task("T1", "Implementation", "developer")])
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    state = read_state(fixture.state_path)
    state["sprintengine"]["agentTimeoutSeconds"] = 1
    # Liveness lives on the task lease now (MC-1591): stale its heartbeat so the
    # expiry sweep measures the owner as gone.
    get_task(state, "T1")["lease"]["heartbeatAt"] = "2000-01-01T00:00:00Z"
    write_state(fixture.state_path, state)

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert claimed["task"]["id"] == "T1"
    assert claimed["releasedExpired"][0]["agentId"] == "developer-1"

    state = read_state(fixture.state_path)
    # Derived liveness: the expired owner is released to the queue, so it drops out
    # of the lease-derived worker view; the successor now owns the task.
    assert worker_view(fixture, "developer-1")["status"] == "idle"
    assert worker_view(fixture, "developer-2")["currentTaskId"] == "T1"
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
    # Liveness lives on the task lease now (MC-1591): stale its heartbeat so the
    # expiry sweep measures the owner as gone.
    get_task(state, "T1")["lease"]["heartbeatAt"] = "2000-01-01T00:00:00Z"
    write_state(fixture.state_path, state)

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert claimed["task"]["id"] == "T1"
    assert claimed["releasedExpired"][0]["agentId"] == "developer-1"

    state = read_state(fixture.state_path)
    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
    assert any(record["reason"] == "agent_expired_release" and record["agentId"] == "developer-1" for record in dispatches)
    # Released to the queue, developer-1 holds no active lease and no implementer
    # stamp (the task went back to todo), so it drops out of the derived roster
    # entirely — the lease-model form of the idle-no-target reset. The successor
    # owns the task.
    projection = fixture.cli.run("projection")
    assert "developer-1" not in projection["roster"]
    assert projection["roster"]["developer-2"]["currentTaskId"] == "T1"


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
    # Liveness lives on the task lease now (MC-1591): stale its heartbeat so the
    # expiry sweep measures the owner as gone.
    get_task(state, "T1")["lease"]["heartbeatAt"] = "2000-01-01T00:00:00Z"
    write_state(fixture.state_path, state)

    refused = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert refused["claimed"] is False
    assert refused["reason"] == "no_ready_task"
    assert refused["releasedExpired"] == []

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "review"
    assert task_record["ownerAgentId"] == "developer-1"


def test_a_completed_worker_id_may_claim_again(tmp_path) -> None:
    # D2 (MC-1591) dropped the per-task-for-life cap: once developer-fixture's T1 is
    # done it holds no active lease, so the SAME id may claim the next ready task.
    # This is what ended the retire/re-add churn — a spent id is reusable.
    fixture = create_team(
        tmp_path,
        "completed-agent-may-reclaim",
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
    published = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Shipped T1.")
    assert published["nextStatus"] == "done"
    assert_task_status(read_state(fixture.state_path), "T1", "done")

    # The same id, now holding no active lease, claims T2.
    reclaim = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert reclaim["claimed"] is True
    assert reclaim["task"]["id"] == "T2"
    state = read_state(fixture.state_path)
    assert_task_status(state, "T2", "in_progress")
    assert get_task(state, "T2")["lease"]["workerId"] == "developer-fixture"


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
