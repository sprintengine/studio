from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from helpers import SwarmCli, create_team, get_task, read_state, task
from sprintengine_core import store
from sprintengine_core.tool import append_task_activity
from sprintengine_core.tool.state import record_agent_heartbeat, record_agent_join, record_agent_leave


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
    for lifecycle_status in ("review", "testing", "product"):
        assert (team_dir / "tasks" / lifecycle_status).is_dir()
    for status in store.ARTIFACT_STATUSES:
        assert (team_dir / "artifacts" / status).is_dir()
    for folder in store.SUPPORT_DIRS:
        assert (team_dir / folder).is_dir()
    assert (team_dir / "metrics" / "agent-feedback.jsonl").is_file()
    for lock_file in store.LOCK_STATE_FILES:
        lock_state = json.loads((team_dir / lock_file).read_text(encoding="utf-8"))
        assert lock_state["status"] == "idle"


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
    assert (state_path.parent / "tasks" / "testing").is_dir()
    assert (state_path.parent / "tasks" / "product").is_dir()
    assert (state_path.parent / "artifacts" / "recorded").is_dir()
    assert (state_path.parent / "events.jsonl").is_file()
    assert (state_path.parent / "dispatch.jsonl").is_file()


def test_task_claim_normalizes_agent_lifecycle_and_dispatch_ledger(tmp_path) -> None:
    fixture = create_team(tmp_path, "agent-lifecycle-task-dispatch", [task("T1", "Implement core", "developer")])

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    run = store.load_run_yaml(fixture.team_dir)
    agent = run["agents"]["developer-1"]
    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")
    projection = fixture.cli.run("projection")

    assert claimed["claimed"] is True
    assert agent["role"] == "developer"
    assert agent["status"] == "running"
    assert agent["currentTaskId"] == "T1"
    assert agent["joinedAt"]
    assert agent["heartbeatAt"]
    assert agent["subscription"] == {"mode": "none"}
    assert agent["currentDispatch"]["targetKind"] == "task"
    assert agent["currentDispatch"]["taskId"] == "T1"
    assert agent["currentDispatch"]["reason"] == "task_claimed"
    assert len(dispatches) == 1
    assert dispatches[0]["id"] == agent["currentDispatch"]["dispatchId"]
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


def test_gate_claim_records_current_gate_mirror_and_dispatch_ledger(tmp_path) -> None:
    record = task("T1", "Review backend", "developer", "review")
    record["qualityGates"] = [
        {
            "id": "code_reviewer",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "Review code.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "agent-lifecycle-gate-dispatch", [record])

    claimed = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "code-reviewer")
    run = store.load_run_yaml(fixture.team_dir)
    agent = run["agents"]["code-reviewer"]
    dispatches = store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")

    assert claimed["claimed"] is True
    assert agent["status"] == "running"
    assert agent["currentTaskId"] == "T1"
    assert agent["currentGateId"] == "code_reviewer"
    assert agent["currentGate"] == {"taskId": "T1", "gateId": "code_reviewer", "attemptId": "GA-001"}
    assert agent["currentDispatch"]["targetKind"] == "gate"
    assert agent["currentDispatch"]["gateId"] == "code_reviewer"
    assert agent["currentDispatch"]["attemptId"] == "GA-001"
    assert len(dispatches) == 1
    assert dispatches[0]["id"] == agent["currentDispatch"]["dispatchId"]
    assert dispatches[0]["target"] == {
        "kind": "gate",
        "taskId": "T1",
        "gateId": "code_reviewer",
        "attemptId": "GA-001",
    }

    resumed = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "code-reviewer")
    assert resumed["resumed"] is True
    assert len(store.read_jsonl_file(fixture.team_dir / "dispatch.jsonl")) == 1


def test_agent_lifecycle_helpers_persist_join_heartbeat_and_leave_metadata(tmp_path) -> None:
    fixture = create_team(tmp_path, "agent-lifecycle-helper-metadata", [])
    state = read_state(fixture.state_path)

    joined = record_agent_join(state, "developer-1", "developer", subscription_mode="poll")
    first_heartbeat = joined["heartbeatAt"]
    record_agent_heartbeat(state, "developer-1", "developer")
    left = record_agent_leave(state, "developer-1", "developer", reason="terminal closed")
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    persisted = store.load_run_yaml(fixture.team_dir)["agents"]["developer-1"]
    assert persisted["role"] == "developer"
    assert persisted["status"] == "left"
    assert persisted["joinedAt"]
    assert persisted["heartbeatAt"] >= first_heartbeat
    assert persisted["leftAt"] == left["leftAt"]
    assert persisted["leaveReason"] == "terminal closed"
    assert persisted["subscription"]["mode"] == "poll"
    assert persisted["subscription"]["subscribedAt"]
    assert persisted["currentDispatch"] is None
    assert persisted["currentTaskId"] is None


def test_agent_heartbeat_does_not_reactivate_left_or_dead_agents(tmp_path) -> None:
    fixture = create_team(tmp_path, "agent-heartbeat-terminal-states", [])
    state = read_state(fixture.state_path)

    record_agent_join(state, "developer-1", "developer")
    record_agent_leave(state, "developer-1", "developer", reason="terminal closed")
    record_agent_heartbeat(state, "developer-1", "developer")
    left = state["agents"]["developer-1"]
    assert left["status"] == "left"

    left["status"] = "dead"
    record_agent_heartbeat(state, "developer-1", "developer")
    assert left["status"] == "dead"

    rejoined = record_agent_join(state, "developer-1", "developer")
    assert rejoined["status"] == "idle"
    assert "leftAt" not in rejoined
    assert "leaveReason" not in rejoined
    assert "deadAt" not in rejoined
    assert "deathReason" not in rejoined


def test_agent_reactivation_clears_terminal_state_metadata(tmp_path) -> None:
    fixture = create_team(tmp_path, "agent-reactivation-clears-terminal-metadata", [task("T1", "Implement", "developer")])
    state = read_state(fixture.state_path)

    agent = record_agent_join(state, "developer-1", "developer")
    agent["status"] = "dead"
    agent["deadAt"] = "2000-01-01T00:00:00Z"
    agent["deathReason"] = "heartbeat_expired"
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    persisted = store.load_run_yaml(fixture.team_dir)["agents"]["developer-1"]

    assert claimed["claimed"] is True
    assert persisted["status"] == "running"
    assert persisted["currentTaskId"] == "T1"
    assert "deadAt" not in persisted
    assert "deathReason" not in persisted
    assert "leftAt" not in persisted
    assert "leaveReason" not in persisted


def test_lifecycle_statuses_materialize_and_project_without_ready_claimability(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "quality-lifecycle-statuses",
        [
            task("T1", "In review", "developer", "review"),
            task("T2", "In testing", "developer", "testing"),
            task("T3", "In product", "developer", "product"),
            task("T4", "Ready implementation", "developer"),
        ],
    )

    payload = fixture.cli.run("task", "refresh-ready")
    projection = fixture.cli.run("projection")

    assert payload["readyTaskIds"] == ["T4"]
    assert (fixture.team_dir / "tasks" / "review" / "0001-T1.json").is_file()
    assert (fixture.team_dir / "tasks" / "testing" / "0002-T2.json").is_file()
    assert (fixture.team_dir / "tasks" / "product" / "0003-T3.json").is_file()
    assert projection["board"]["counts"]["review"] == 1
    assert projection["board"]["counts"]["testing"] == 1
    assert projection["board"]["counts"]["product"] == 1
    assert projection["counts"]["tasks"]["review"] == 1
    assert store.validate_task_status("review") == "review"


def test_quality_policy_and_gates_skip_absent_roster_roles(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "quality-roster-skip",
        [task("T1", "Normal implementation", "developer", owned_paths=["src/server.py"])],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    projection = fixture.cli.run("projection")
    task_record = next(record for record in projection["tasks"] if record["id"] == "T1")
    run = store.load_run_yaml(fixture.team_dir)

    assert run["qualityPolicy"]["rosterDriven"] is True
    assert run["qualityPolicy"]["lifecyclePhases"] == ["review", "testing", "product"]
    assert task_record["qualityGates"] == []


def test_plan_add_task_requires_configured_roster_for_quality_gated_runs(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "quality-no-unconfigured-plan-add",
        [],
    )

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

    assert "Cannot add quality-gated Sprint Engine tasks before configuring a roster" in rejected.stderr


def test_plan_add_task_roots_new_tasks_on_the_plan_gate(tmp_path) -> None:
    """Live-reproduced planning defect: architects created implementation
    tasks with no dependency on the plan-review gate, so work became
    claimable before the plan was approved. Dependency-free tasks must root
    on the plan gate; explicit dependencies stay untouched (covered
    transitively)."""
    fixture = create_team(tmp_path, "plan-gate-rooting", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
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
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
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


def test_cross_cutting_tasks_get_architect_quality_gate_when_rostered(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "quality-architect-gate",
        [],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Touch Sprint Engine store",
        "--role",
        "developer",
        "--path",
        "sprintengine_core/store.py",
    )
    gate = added["task"]["qualityGates"][0]

    assert [entry["id"] for entry in added["task"]["qualityGates"]] == ["architect_review"]
    assert gate["phase"] == "review"
    assert gate["role"] == "architect"
    assert gate["required"] is True
    assert gate["status"] == "pending"
    assert gate["allowSelfReview"] is True


def test_frontend_paths_get_frontend_review_gate_when_frontend_rostered(tmp_path) -> None:
    fixture = create_team(tmp_path, "quality-frontend-review-gate", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "frontend": {"role": "frontend", "status": "idle", "currentTaskId": None},
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Update board UI",
        "--role",
        "developer",
        "--path",
        "src/renderer/src/components/panels/SprintEngineBoardPanel.tsx",
    )

    assert [gate["id"] for gate in added["task"]["qualityGates"]] == ["frontend_review"]
    gate = added["task"]["qualityGates"][0]
    assert gate["phase"] == "review"
    assert gate["role"] == "frontend"
    assert gate["allowSelfReview"] is True


def test_produces_implementation_flag_opts_non_developer_task_into_gates(tmp_path) -> None:
    fixture = create_team(tmp_path, "quality-produces-implementation-flag", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "code-reviewer": {"role": "code_reviewer", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Architect edits workflow prompt",
        "--role",
        "architect",
        "--path",
        ".agents/skills/sprintengine/SKILL.md",
        "--produces-implementation",
    )

    assert added["task"]["producesImplementation"] is True
    assert [gate["id"] for gate in added["task"]["qualityGates"]] == ["architect_review", "code_reviewer"]


def test_quality_gate_override_flags_filter_and_require_gates(tmp_path) -> None:
    fixture = create_team(tmp_path, "quality-override-flags", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
        "code-reviewer": {"role": "code_reviewer", "status": "idle", "currentTaskId": None},
        "tester": {"role": "tester", "status": "idle", "currentTaskId": None},
        "product": {"role": "product", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Backend implementation",
        "--role",
        "developer",
        "--path",
        "sprintengine_core/tool.py",
        "--product-facing",
        "--no-review",
        "--no-product-acceptance",
        "--require-gate",
        "tester",
    )

    assert [gate["id"] for gate in added["task"]["qualityGates"]] == ["tester"]
    assert added["task"]["qualityGates"][0]["phase"] == "testing"


def test_no_quality_gates_and_skip_gate_flags_persist_explicit_gate_list(tmp_path) -> None:
    fixture = create_team(tmp_path, "quality-no-gates-skip-gate", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
        "code-reviewer": {"role": "code_reviewer", "status": "idle", "currentTaskId": None},
        "tester": {"role": "tester", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    no_gates = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Docs-only implementation note",
        "--role",
        "developer",
        "--path",
        "docs/sprintengine-cli.md",
        "--no-quality-gates",
    )
    skipped = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "CLI implementation",
        "--role",
        "developer",
        "--path",
        "sprintengine_core/tool.py",
        "--skip-gate",
        "code-reviewer",
    )

    assert no_gates["task"]["qualityGates"] == []
    assert [gate["id"] for gate in skipped["task"]["qualityGates"]] == ["tester"]


def test_product_rostered_internal_tasks_skip_product_gate_by_default(tmp_path) -> None:
    fixture = create_team(tmp_path, "quality-product-skips-internal", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
        "product": {"role": "product", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Refine internal CLI lifecycle",
        "--role",
        "developer",
        "--path",
        "sprintengine_core/tool.py",
        "--not-product-facing",
    )

    assert added["task"]["productFacing"] is False
    assert [gate["id"] for gate in added["task"]["qualityGates"]] == []


def test_product_facing_tasks_get_product_gate_when_product_is_rostered(tmp_path) -> None:
    fixture = create_team(tmp_path, "quality-product-facing-gate", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
        "product": {"role": "product", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Ship user-visible status panel",
        "--role",
        "developer",
        "--path",
        "src/renderer/src/components/StatusPanel.tsx",
        "--product-facing",
    )

    assert added["task"]["productFacing"] is True
    assert [gate["id"] for gate in added["task"]["qualityGates"]] == ["product"]
    gate = added["task"]["qualityGates"][0]
    assert gate["phase"] == "product"
    assert gate["role"] == "product"
    assert gate["required"] is True


def test_plan_update_persists_product_facing_signal_and_recomputes_gates(tmp_path) -> None:
    fixture = create_team(tmp_path, "quality-product-facing-update", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-fixture": {"role": "developer", "status": "idle", "currentTaskId": None},
        "product": {"role": "product", "status": "idle", "currentTaskId": None},
    }
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)
    added = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Tune status labels",
        "--role",
        "developer",
        "--path",
        "src/renderer/src/components/StatusPanel.tsx",
    )

    updated = fixture.cli.run("plan", "update-task", "--task-id", added["task"]["id"], "--product-facing")

    assert updated["task"]["productFacing"] is True
    assert [gate["id"] for gate in updated["task"]["qualityGates"]] == ["product"]


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


def test_changes_requested_tasks_stay_in_changes_requested_folder_and_are_claimable(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "changes-requested-ready",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Needs revision", "developer", "changes_requested", depends_on=["T1"]),
        ],
    )

    listed = fixture.cli.run("task", "list", "--role", "developer")
    refreshed = fixture.cli.run("task", "refresh-ready")

    assert refreshed["readyTaskIds"] == ["T2"]
    assert ready_queue_ids(fixture.team_dir) == []
    assert (fixture.team_dir / "tasks" / "changes_requested" / "0002-T2.json").is_file()
    stored = json.loads((fixture.team_dir / "tasks" / "changes_requested" / "0002-T2.json").read_text(encoding="utf-8"))
    assert stored["status"] == "changes_requested"
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert [entry["id"] for entry in listed["readyTasks"]] == ["T2"]
    assert listed["readyTasks"][0]["status"] == "changes_requested"
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T2"
    assert claimed["task"]["status"] == "in_progress"


def test_task_next_prioritizes_changes_requested_before_normal_ready(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "changes-requested-priority",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Normal ready", "developer", depends_on=["T1"]),
            task("T3", "Needs revision", "developer", "changes_requested", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T3"
    assert (fixture.team_dir / "tasks" / "in_progress" / "0003-T3.json").is_file()
    assert (fixture.team_dir / "tasks" / "ready" / "0002-T2.json").is_file()


def test_projection_reports_changes_requested_distinctly(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "changes-requested-projection",
        [
            task("T1", "Dependency", "developer", "done"),
            task("T2", "Needs revision", "developer", "changes_requested", depends_on=["T1"]),
            task("T3", "Normal ready", "developer", depends_on=["T1"]),
        ],
    )
    fixture.cli.run("task", "refresh-ready")

    projection = fixture.cli.run("projection")
    tasks = {task["id"]: task for task in projection["tasks"]}

    assert projection["board"]["counts"]["changes_requested"] == 1
    assert projection["counts"]["changesRequested"] == 1
    assert tasks["T2"]["status"] == "changes_requested"
    assert tasks["T2"]["stateStatus"] == "changes_requested"
    assert tasks["T3"]["status"] == "ready"


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
