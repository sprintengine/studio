"""Folder-store layout, ready-queue materialization, and projection (MC-1542).

The store's status folders are exactly `store.TASK_STATUSES` — the gate-era
`testing`, `product`, and `changes_requested` folders are gone, and so is the
`qualityPolicy` block in run.yaml. `ready` remains the one derived folder: a
materialized view of `todo` tasks whose dependencies are done.
"""
from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from helpers import SwarmCli, create_team, get_task, read_state, task
from sprintengine_core import store
from sprintengine_core.tool import append_task_activity


RETIRED_TASK_FOLDERS = ("testing", "product", "changes_requested")
# MC-1828 deleted the plan-review-file flow; init must stop creating its folder.
RETIRED_SUPPORT_FOLDERS = ("plan-reviews",)


def test_init_creates_folder_store_layout(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "folder-layout" / "run.yaml"
    payload = SwarmCli(state_path).run("init", "--goal", "Create a folder store")

    team_dir = state_path.parent
    assert payload["ok"] is True
    assert (team_dir / "run.yaml").is_file()
    assert (team_dir / "events.jsonl").is_file()
    assert (team_dir / "dispatch.jsonl").is_file()
    for status in store.TASK_STATUSES:
        assert (team_dir / "tasks" / status).is_dir()
    for retired in RETIRED_TASK_FOLDERS:
        assert not (team_dir / "tasks" / retired).exists()
    for status in store.ARTIFACT_STATUSES:
        assert (team_dir / "artifacts" / status).is_dir()
    for folder in store.SUPPORT_DIRS:
        assert (team_dir / folder).is_dir()
    for retired in RETIRED_SUPPORT_FOLDERS:
        assert retired not in store.SUPPORT_DIRS
        assert not (team_dir / retired).exists()
    assert (team_dir / "metrics" / "agent-feedback.jsonl").is_file()
    for lock_file in store.LOCK_STATE_FILES:
        lock_state = json.loads((team_dir / lock_file).read_text(encoding="utf-8"))
        assert lock_state["status"] == "idle"
    run = store.load_run_yaml(team_dir)
    assert run["schemaVersion"] == store.RUN_SCHEMA_VERSION
    assert "qualityPolicy" not in run


def test_handover_creates_folder_store_layout(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "handover-layout" / "run.yaml"
    payload = SwarmCli(state_path).run(
        "handover",
        "--name",
        "handover-layout",
        "--goal",
        "Bootstrap from handover",
        "--handover-text",
        "Build the feature.",
    )

    assert payload["ok"] is True
    assert (state_path.parent / "run.yaml").is_file()
    assert (state_path.parent / "tasks" / "ready").is_dir()
    assert (state_path.parent / "tasks" / "review").is_dir()
    for retired in RETIRED_TASK_FOLDERS:
        assert not (state_path.parent / "tasks" / retired).exists()
    assert (state_path.parent / "artifacts" / "recorded").is_dir()
    assert (state_path.parent / "events.jsonl").is_file()
    assert (state_path.parent / "dispatch.jsonl").is_file()


def test_task_claim_mints_lease_and_records_dispatch_ledger(tmp_path) -> None:
    # No agents map (MC-1591): the claim mints a lease on the task record and the
    # worker view echoed on the claim + the lease-derived projection roster are
    # both reconstructed from it and the append-only dispatch ledger.
    fixture = create_team(tmp_path, "agent-lifecycle-task-dispatch", [task("T1", "Implement core", "developer")])

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
    projection = fixture.cli.run("projection")

    assert claimed["claimed"] is True
    claim_agent = claimed["agent"]
    assert claim_agent["role"] == "developer"
    assert claim_agent["status"] == "running"
    assert claim_agent["currentTaskId"] == "T1"
    assert claim_agent["currentDispatch"]["targetKind"] == "task"
    assert claim_agent["currentDispatch"]["taskId"] == "T1"
    assert claim_agent["currentDispatch"]["reason"] == "task_claimed"

    # The lease on the task record is the sole ownership authority; no agents map.
    assert "agents" not in read_state(fixture.state_path)
    assert "agents" not in store.load_run_yaml(fixture.team_dir)
    t1 = get_task(read_state(fixture.state_path), "T1")
    assert t1["status"] == "in_progress"
    assert t1["ownerAgentId"] == "developer-1"
    assert t1["lease"]["workerId"] == "developer-1"

    assert len(dispatches) == 1
    assert dispatches[0]["id"] == claim_agent["currentDispatch"]["dispatchId"]
    assert dispatches[0]["agentId"] == "developer-1"
    assert dispatches[0]["role"] == "developer"
    assert dispatches[0]["target"] == {"kind": "task", "taskId": "T1"}
    assert dispatches[0]["reason"] == "task_claimed"
    assert dispatches[0]["timestamp"]
    assert projection["roster"]["developer-1"]["currentDispatch"]["dispatchId"] == dispatches[0]["id"]
    assert projection["dispatches"][0]["id"] == dispatches[0]["id"]

    resumed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert resumed["reason"] == "agent_already_has_active_task"
    assert len(store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")) == 1


def test_review_status_materializes_and_projects_without_ready_claimability(tmp_path) -> None:
    # `review` is the one post-implementation phase and an OWNED status: it gets a
    # status folder and a board column, but never joins the ready queue.
    fixture = create_team(
        tmp_path,
        "review-lifecycle-status",
        [
            task("T1", "In review", "developer", "review", owner="developer-1"),
            task("T2", "Ready implementation", "developer"),
        ],
    )

    payload = fixture.cli.run("task", "refresh-ready")
    projection = fixture.cli.run("projection")

    assert payload["readyTaskIds"] == ["T2"]
    assert (fixture.team_dir / "tasks" / "review" / "0001-T1.json").is_file()
    assert projection["board"]["counts"]["review"] == 1
    assert projection["counts"]["tasks"]["review"] == 1
    assert "changesRequested" not in projection["counts"]
    assert store.validate_task_status("review") == "review"
    for retired in RETIRED_TASK_FOLDERS:
        with pytest.raises(ValueError):
            store.validate_task_status(retired)


def test_plan_add_task_rejects_a_role_absent_from_configured_roles(tmp_path) -> None:
    # Post-lease authority (MC-1591): run membership is `configuredRoles`, not a
    # seated roster. A configured run rejects a task for a role it did not enable.
    fixture = create_team(tmp_path, "plan-add-unconfigured-roster", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["configuredRoles"] = ["architect"]
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    rejected = fixture.cli.run_failure(
        "plan",
        "add-task",
        "--title",
        "Touch Sprint Engine tool",
        "--role",
        "developer",
        "--path",
        "sprintengine_core/tool.py",
    )

    assert "is not enabled for this run" in rejected.stderr


def test_plan_add_task_roots_new_tasks_on_the_plan_gate(tmp_path) -> None:
    """Live-reproduced planning defect: architects created implementation
    tasks with no dependency on the plan-review gate, so work became
    claimable before the plan was approved. Dependency-free tasks must root
    on the plan gate; explicit dependencies stay untouched (covered
    transitively)."""
    fixture = create_team(tmp_path, "plan-gate-rooting", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["tasks"] = [
        {
            "id": "T0",
            "title": "Review architect plan artifact",
            "role": "architect",
            "status": "needs_input",
            "ownerAgentId": None,
            "dependsOn": [],
            "ownedPaths": [],
            "acceptanceCriteria": [],
            "implementationNotes": [],
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": []},
            "notes": [],
            "startedAt": None,
            "completedAt": None,
        }
    ]
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    rooted = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Implementation task with no explicit deps",
        "--role",
        "developer",
    )
    assert rooted["task"]["dependsOn"] == ["T0"]

    chained = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Task with an explicit dependency",
        "--role",
        "developer",
        "--depends-on",
        rooted["task"]["id"],
    )
    assert chained["task"]["dependsOn"] == [rooted["task"]["id"]]


def test_plan_add_task_keeps_empty_dependencies_without_a_plan_gate(tmp_path) -> None:
    fixture = create_team(tmp_path, "plan-gate-absent", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Ungated run keeps free roots",
        "--role",
        "developer",
    )
    assert added["task"]["dependsOn"] == []


def _rostered(fixture) -> None:
    # Under the lease model the run's "roster" is `configuredRoles`, not an agents
    # map. These tests only need the run marked roster-configured; role validation
    # no-ops without a configured set (legacy/headless boundary).
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)


def test_planned_tasks_carry_no_quality_gate_state(tmp_path) -> None:
    # Gate derivation is gone: a task's post-implementation work is its `phases`
    # list, never a per-path/per-role gate set derived at plan time.
    fixture = create_team(tmp_path, "plan-no-gates", [])
    _rostered(fixture)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Touch Sprint Engine store and the board UI",
        "--role",
        "developer",
        "--path",
        "sprintengine_core/store.py",
        "--path",
        "src/renderer/src/components/panels/SprintEngineBoardPanel.tsx",
    )

    assert "qualityGates" not in added["task"]
    # Absent `phases` means "inherit the run's defaultPhases" (i.e. review).
    assert "phases" not in added["task"]
    projected = next(record for record in fixture.cli.run("projection")["tasks"] if record["id"] == added["task"]["id"])
    assert "qualityGates" not in projected
    assert "qualityGateSummary" not in projected


def test_legacy_required_sweeps_key_is_inert(tmp_path) -> None:
    # MC-1825 removed the sweep concept engine-side while ~13 existing run.yamls
    # still carry `requiredSweeps`. The key must load without error and reach
    # neither the in-memory state nor the projection, so an old run finishes on
    # the same rules as a new one.
    fixture = create_team(tmp_path, "legacy-required-sweeps", [task("T1", "Work", "developer")])
    run = store.load_run_yaml(fixture.team_dir)
    run["requiredSweeps"] = ["tester"]
    store.atomic_write_yaml(fixture.team_dir / store.RUN_FILE, run)

    assert "requiredSweeps" not in read_state(fixture.state_path)

    _rostered(fixture)
    projection = json.loads((fixture.team_dir / store.PROJECTION_FILE).read_text(encoding="utf-8"))
    assert "requiredSweeps" not in projection["run"]


def test_plan_add_and_update_persist_product_facing_and_produces_implementation(tmp_path) -> None:
    # Both flags survive as plain persisted task metadata. They no longer derive
    # gates; nothing in the engine reads them today.
    fixture = create_team(tmp_path, "plan-task-flags", [])
    _rostered(fixture)

    internal = fixture.cli.run(
        "plan", "add-task", "--title", "Refine internal CLI lifecycle",
        "--role", "developer", "--path", "sprintengine_core/tool.py", "--not-product-facing",
    )
    assert internal["task"]["productFacing"] is False

    architect_impl = fixture.cli.run(
        "plan", "add-task", "--title", "Architect edits workflow prompt",
        "--role", "architect", "--path", ".agents/skills/sprintengine/SKILL.md", "--produces-implementation",
    )
    assert architect_impl["task"]["producesImplementation"] is True

    updated = fixture.cli.run("plan", "update-task", "--task-id", internal["task"]["id"], "--product-facing")
    assert updated["task"]["productFacing"] is True
    assert "qualityGates" not in updated["task"]


def test_folder_store_path_validation_rejects_machine_specific_paths() -> None:
    rejected = [
        "/tmp/file.py",
        r"C:\workspace\repo\file.py",
        r"\\server\share\file.py",
        "~/repo/file.py",
        "../outside.py",
        "https://example.test/file.py",
    ]
    for value in rejected:
        with pytest.raises(ValueError):
            store.validate_project_relative_path(value, field="path")

    assert store.validate_project_relative_path("src/main.py", field="path") == "src/main.py"


def test_task_log_rejects_absolute_evidence_file_paths(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "reject-evidence-path",
        [task("T1", "Implementation", "developer")],
    )

    failure = fixture.cli.run_failure(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--file",
        "/tmp/not-project.py",
    )

    assert "--file must use project-root-relative paths" in failure.stderr


def test_folder_lock_reports_and_recovers_stale_locks(tmp_path) -> None:
    lock_path = tmp_path / "runner" / "claim.lock"
    lock_path.parent.mkdir(parents=True)
    lock_path.write_text(json.dumps({"pid": 999999, "createdAt": "2020-01-01T00:00:00Z"}), encoding="utf-8")
    stale_time = time.time() - 120
    os.utime(lock_path, (stale_time, stale_time))

    folder_lock = store.FolderLock(lock_path, stale_after_seconds=1, timeout=0.01, poll=0.001)
    report = folder_lock.inspect()
    assert report.exists is True
    assert report.stale is True
    assert report.owner and report.owner["pid"] == 999999

    acquired = folder_lock.acquire(recover_stale=True)
    try:
        assert acquired.exists is True
        assert acquired.stale is False
        assert json.loads(lock_path.read_text(encoding="utf-8"))["pid"] == os.getpid()
    finally:
        folder_lock.release()

    assert lock_path.exists() is False


def test_refresh_ready_recovers_stale_ready_queue_lock(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "stale-ready-lock-recovery",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Implementation", "developer", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")
    lock_path = fixture.team_dir / "runner" / "ready.queue.lock"
    lock_path.write_text(json.dumps({"pid": 999999, "createdAt": "2020-01-01T00:00:00Z"}), encoding="utf-8")
    stale_time = time.time() - 600
    os.utime(lock_path, (stale_time, stale_time))

    payload = fixture.cli.run("task", "refresh-ready")

    assert payload["readyTaskIds"] == ["T2"]
    assert lock_path.exists() is False


def test_atomic_write_and_move_helpers(tmp_path) -> None:
    target = tmp_path / "nested" / "state.json"
    store.atomic_write_json(target, {"ok": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    assert not list(target.parent.glob("*.tmp"))

    destination = tmp_path / "other" / "state.json"
    store.atomic_move(target, destination)
    assert target.exists() is False
    assert json.loads(destination.read_text(encoding="utf-8")) == {"ok": True}


def ready_queue_ids(team_dir) -> list[str]:
    return [
        json.loads(path.read_text(encoding="utf-8"))["id"]
        for path in sorted((team_dir / "tasks" / "ready").glob("*.json"))
    ]


def store_file_fingerprints(team_dir) -> dict[str, tuple[int, bytes]]:
    paths = [
        team_dir / "run.yaml",
        team_dir / "events.jsonl",
        team_dir / "projection.json",
        *sorted((team_dir / "tasks").glob("*/*.json")),
    ]
    return {
        path.relative_to(team_dir).as_posix(): (path.stat().st_mtime_ns, path.read_bytes())
        for path in paths
        if path.exists()
    }


def test_ready_queue_materializes_dependency_satisfied_tasks_in_topological_order(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "ready-materialized",
        [
            task("T1", "Foundation", "developer", "done"),
            task("T3", "Second dependent", "developer", depends_on=["T2"]),
            task("T2", "First dependent", "developer", depends_on=["T1"]),
            task("T4", "Independent", "tester"),
        ],
    )

    payload = fixture.cli.run("task", "refresh-ready")

    assert payload["readyTaskIds"] == ["T2", "T4"]
    assert payload["orderedTaskIds"] == ["T1", "T2", "T3", "T4"]
    assert ready_queue_ids(fixture.team_dir) == ["T2", "T4"]
    assert [path.name for path in sorted((fixture.team_dir / "tasks" / "ready").glob("*.json"))] == [
        "0002-T2.json",
        "0004-T4.json",
    ]


def test_ready_queue_excludes_blocked_active_and_terminal_tasks(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "ready-exclusions",
        [
            task("T1", "Done dependency", "developer", "done"),
            task("T2", "Ready", "developer", depends_on=["T1"]),
            task("T3", "Canceled dependency", "developer", "canceled", depends_on=["T1"]),
            task("T4", "Active", "developer", "in_progress", owner="developer-a"),
            task("T5", "Needs input", "developer", "needs_input", owner="developer-b"),
            task("T6", "Already done", "developer", "done"),
        ],
    )
    payload = fixture.cli.run("task", "refresh-ready")

    assert payload["readyTaskIds"] == ["T2"]
    assert ready_queue_ids(fixture.team_dir) == ["T2"]
    assert (fixture.team_dir / "tasks" / "in_progress" / "0004-T4.json").is_file()
    assert (fixture.team_dir / "tasks" / "needs_input" / "0005-T5.json").is_file()
    assert (fixture.team_dir / "tasks" / "done" / "0001-T1.json").is_file()
    assert (fixture.team_dir / "tasks" / "done" / "0006-T6.json").is_file()
    assert (fixture.team_dir / "tasks" / "canceled" / "0003-T3.json").is_file()


def test_ready_queue_keeps_needs_triage_tasks_in_todo_projection(tmp_path) -> None:
    triage_task = task("T2", "Needs triage", "developer", depends_on=["T1"])
    triage_task["needsTriage"] = True
    fixture = create_team(
        tmp_path,
        "needs-triage-ready-exclusion",
        [
            task("T1", "Done dependency", "developer", "done"),
            triage_task,
            task("T3", "Normal ready", "developer", depends_on=["T1"]),
        ],
    )

    payload = fixture.cli.run("task", "refresh-ready")
    projection = fixture.cli.run("projection")
    triage_projection = next(record for record in projection["tasks"] if record["id"] == "T2")
    ready_projection = next(record for record in projection["tasks"] if record["id"] == "T3")

    assert payload["readyTaskIds"] == ["T3"]
    assert ready_queue_ids(fixture.team_dir) == ["T3"]
    assert (fixture.team_dir / "tasks" / "todo" / "0002-T2.json").is_file()
    assert triage_projection["needsTriage"] is True
    assert triage_projection["boardColumn"] == "todo"
    assert ready_projection["needsTriage"] is False
    assert projection["board"]["columns"]["todo"]["taskIds"] == ["T2"]


def test_folder_store_mutation_requires_run_yaml(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "folder-store-no-state-yaml",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Implementation", "developer", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")
    fixture.state_path.unlink()

    with pytest.raises(AssertionError, match="folder store is not initialized"):
        fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")


def test_concurrent_task_next_claims_available_work_once(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "concurrent-claim",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Implementation", "developer", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(
            lambda agent_id: fixture.cli.run("task", "next", "--role", "developer", "--id", agent_id),
            ["developer-a", "developer-b"],
        ))

    claimed = [result for result in results if result["claimed"]]
    not_claimed = [result for result in results if not result["claimed"]]
    assert len(claimed) == 1
    assert claimed[0]["task"]["id"] == "T2"
    assert len(not_claimed) == 1
    assert not_claimed[0]["reason"] == "no_ready_task"


def test_task_list_reads_ready_tasks_without_rewriting_folder_store(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-list-read-only",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Implementation", "developer", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")
    before = store_file_fingerprints(fixture.team_dir)

    listed = fixture.cli.run("task", "list", "--role", "developer")

    assert [entry["id"] for entry in listed["readyTasks"]] == ["T2"]
    assert store_file_fingerprints(fixture.team_dir) == before


def test_task_next_claims_from_materialized_ready_queue(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "claim-from-ready-queue",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Implementation", "developer", depends_on=["T1"]),
        ],
    )

    listed = fixture.cli.run("task", "list", "--role", "developer")
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert [entry["id"] for entry in listed["readyTasks"]] == ["T2"]
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T2"
    assert ready_queue_ids(fixture.team_dir) == []
    assert (fixture.team_dir / "tasks" / "in_progress" / "0002-T2.json").is_file()


def test_task_next_claims_without_preclaim_projection_rewrite(tmp_path, monkeypatch) -> None:
    fixture = create_team(
        tmp_path,
        "single-sync-claim",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Implementation", "developer", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")
    import sprintengine_core.tool as tool

    sync_calls = 0
    original_sync = tool.folder_store.sync_state_to_store

    def count_sync(*args, **kwargs):
        nonlocal sync_calls
        sync_calls += 1
        return original_sync(*args, **kwargs)

    monkeypatch.setattr(tool.folder_store, "sync_state_to_store", count_sync)

    class Args:
        state = fixture.state_path
        role = "developer"
        id = "developer-fixture"

    claimed = tool.cmd_task_next(Args())

    assert claimed["claimed"] is True
    assert sync_calls == 1
    assert read_state(fixture.state_path)["tasks"][1]["status"] == "in_progress"


def test_task_claim_claims_without_preclaim_projection_rewrite(tmp_path, monkeypatch) -> None:
    fixture = create_team(
        tmp_path,
        "single-sync-explicit-claim",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Implementation", "developer", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")
    import sprintengine_core.tool as tool

    sync_calls = 0
    original_sync = tool.folder_store.sync_state_to_store

    def count_sync(*args, **kwargs):
        nonlocal sync_calls
        sync_calls += 1
        return original_sync(*args, **kwargs)

    monkeypatch.setattr(tool.folder_store, "sync_state_to_store", count_sync)

    class Args:
        state = fixture.state_path
        task_id = "T2"
        id = "developer-fixture"

    claimed = tool.cmd_task_claim(Args())

    assert claimed["task"]["id"] == "T2"
    assert sync_calls == 1
    assert read_state(fixture.state_path)["tasks"][1]["status"] == "in_progress"


def test_cycle_creation_fails_and_leaves_graph_unchanged(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "cycle-rejection",
        [
            task("T1", "First", "developer", depends_on=["T2"]),
            task("T2", "Second", "developer"),
        ],
    )

    rejected = fixture.cli.run_failure(
        "plan",
        "add-dependency",
        "--task-id",
        "T2",
        "--depends-on",
        "T1",
    )

    assert "Task dependency cycle detected" in rejected.stderr
    state = read_state(fixture.state_path)
    assert get_task(state, "T2")["dependsOn"] == []


def test_lifecycle_writes_task_activity_artifact_files_and_events_jsonl(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "folder-lifecycle-files",
        [task("T1", "Produce review artifact", "developer")],
    )

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Produced artifact.",
        "--file",
        "src/example.py",
    )
    artifact_file = fixture.team_dir / "reviews" / "review.md"
    artifact_file.parent.mkdir(parents=True, exist_ok=True)
    artifact_file.write_text("# Review\n", encoding="utf-8")
    artifact = fixture.cli.run(
        "artifact",
        "add",
        "--task-id",
        "T1",
        "--kind",
        "code_review",
        "--title",
        "Review",
        "--path",
        "reviews/review.md",
        "--created-by",
        "developer-fixture",
        "--ready",
    )["artifact"]

    ready_artifact_path = fixture.team_dir / "artifacts" / "ready_for_review" / f"{artifact['id']}.json"
    task_file = fixture.team_dir / "tasks" / "needs_input" / "0001-T1.json"
    events = [
        json.loads(line)
        for line in (fixture.team_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    task_record = json.loads(task_file.read_text(encoding="utf-8"))

    assert ready_artifact_path.is_file()
    assert task_file.is_file()
    assert any(event["type"] == "artifact_ready_for_review" for event in events)
    assert [entry["type"] for entry in task_record["activity"]] == [
        "claim",
        "evidence",
        "artifact",
        "needs_input",
        "artifact",
    ]


def test_activity_ids_use_max_existing_id_after_compaction() -> None:
    task_record = {"activity": [{"id": "ACT-001"}, {"id": "ACT-003"}]}

    entry = append_task_activity(task_record, "comment", "developer-fixture", "Compacted activity append.")

    assert entry["id"] == "ACT-004"
    assert len({activity["id"] for activity in task_record["activity"]}) == 3


def test_projection_covers_empty_run_summary_and_board(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "empty-projection" / "run.yaml"
    payload = SwarmCli(state_path).run("init", "--goal", "Project the run", "--agent", "developer:developer-1")
    state = read_state(state_path)
    state["tasks"] = []
    state["artifacts"] = []
    state["events"] = []
    store.sync_state_to_store(state_path.parent, state, state_path=state_path)
    SwarmCli(state_path).run("task", "refresh-ready")

    projection = SwarmCli(state_path).run("projection")

    assert payload["ok"] is True
    assert projection["ok"] is True
    assert projection["source"] == "folder_store"
    assert projection["run"]["name"] == "empty-projection"
    assert projection["board"]["counts"]["ready"] == 0
    assert projection["counts"]["needsInput"] == 0
    assert projection["runSummary"]["tasks"]["total"] == 0
    assert (state_path.parent / "projection.json").is_file()


def test_projection_reads_ready_active_and_needs_input_from_folder_store(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "projection-board",
        [
            task("T1", "Foundation", "developer", "done"),
            task("T2", "Ready", "developer", depends_on=["T1"]),
            task("T3", "Waiting", "developer", "needs_input", owner="developer-fixture", depends_on=["T1"]),
            task("T4", "Active", "developer", "in_progress", owner="developer-fixture", depends_on=["T1"]),
        ],
    )

    fixture.cli.run("task", "refresh-ready")
    projection = fixture.cli.run("projection")
    tasks = {task_record["id"]: task_record for task_record in projection["tasks"]}

    assert projection["source"] == "folder_store"
    assert projection["board"]["counts"]["ready"] == 1
    assert projection["board"]["counts"]["in_progress"] == 1
    assert projection["board"]["counts"]["needs_input"] == 1
    assert projection["board"]["columns"]["ready"]["taskIds"] == ["T2"]
    assert tasks["T2"]["status"] == "ready"
    assert tasks["T2"]["stateStatus"] == "todo"
    assert tasks["T3"]["boardColumn"] == "needs_input"
    assert tasks["T4"]["ownerAgentId"] == "developer-fixture"


def test_projection_includes_artifact_review_evidence_feedback_and_activity(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "projection-artifact-review",
        [task("T1", "Reviewable implementation", "developer")],
    )

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Implemented projection.",
        "--file",
        "sprintengine_core/store.py",
        "--command",
        "pytest tests/sprintengine_tool/test_folder_store.py",
        "--result",
        "Passed",
    )
    artifact_file = fixture.team_dir / "reviews" / "projection-review.md"
    artifact_file.parent.mkdir(parents=True, exist_ok=True)
    artifact_file.write_text("# Review\n", encoding="utf-8")
    artifact = fixture.cli.run(
        "artifact",
        "add",
        "--task-id",
        "T1",
        "--kind",
        "code_review",
        "--title",
        "Projection review",
        "--path",
        "reviews/projection-review.md",
        "--created-by",
        "developer-fixture",
    )["artifact"]
    fixture.cli.run(
        "artifact",
        "ready",
        "--artifact-id",
        artifact["id"],
        "--id",
        "developer-fixture",
        "--confidence-pct",
        "88",
        "--hallucination-risk-pct",
        "3",
    )

    projection = fixture.cli.run("projection")
    task_projection = projection["tasks"][0]

    assert projection["counts"]["artifacts"]["ready_for_review"] == 1
    assert projection["artifacts"][0]["id"] == artifact["id"]
    assert task_projection["evidence"]["summary"] == "Implemented projection."
    assert task_projection["feedback"]["scores"]["confidencePct"] == 88
    assert task_projection["needsInput"]["artifactId"] == artifact["id"]
    assert any(entry["type"] == "artifact" for entry in task_projection["activity"])
    assert any(event["type"] == "artifact_ready_for_review" for event in projection["activity"])


def test_projection_reports_stale_folder_locks(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "projection-stale-lock",
        [task("T1", "Implementation", "developer")],
    )
    fixture.cli.run("task", "refresh-ready")
    lock_path = fixture.team_dir / "runner" / "ready.queue.lock"
    lock_path.write_text(json.dumps({"pid": 999999, "createdAt": "2020-01-01T00:00:00Z"}), encoding="utf-8")
    stale_time = time.time() - 600
    os.utime(lock_path, (stale_time, stale_time))

    projection = fixture.cli.run("projection")

    ready_queue_lock = next(lock for lock in projection["locks"]["locks"] if lock["name"] == "readyQueue")
    assert ready_queue_lock["exists"] is True
    assert ready_queue_lock["stale"] is True
    assert projection["locks"]["warnings"][0]["name"] == "readyQueue"
