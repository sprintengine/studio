from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

import multiloop_core.state as state_module
from multiloop_core.state import StateLock, create_state_file, save_state, with_locked_state


REPO_ROOT = Path(__file__).resolve().parents[2]
MULTILOOP_COMMAND = REPO_ROOT / "scripts" / "multiloop"
MULTILOOP_TOOL = REPO_ROOT / "scripts" / "multiloop_tool.py"
REAL_REPO_SWARM_ROOT = (REPO_ROOT / "swarm").resolve()


def _tool_command() -> list[str]:
    return [sys.executable, str(MULTILOOP_TOOL)]


def _usable_bash() -> str | None:
    bash = shutil.which("bash.exe") or shutil.which("bash")
    if bash is None:
        return None
    try:
        completed = subprocess.run(
            [bash, "--version"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return bash


def _wrapper_command() -> list[str]:
    if os.name == "nt":
        bash = _usable_bash()
        if bash is None:
            raise AssertionError("scripts/multiloop requires bash on Windows test hosts")
        return [bash, MULTILOOP_COMMAND.as_posix()]
    return [str(MULTILOOP_COMMAND)]


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def assert_disposable_state_path(state_path: Path) -> None:
    resolved = state_path.resolve()
    if resolved.name != "state.json":
        raise AssertionError(f"Multiloop fixture state must be named state.json: {state_path}")
    if _is_relative_to(resolved, REAL_REPO_SWARM_ROOT):
        raise AssertionError(f"Refusing to run harness against real repo swarm state: {state_path}")


def file_fingerprint(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest, path.stat().st_mtime_ns


@dataclass(frozen=True)
class MultiloopCli:
    cwd: Path
    state_path: Path | None = None

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        command = _tool_command()
        if self.state_path is not None:
            assert_disposable_state_path(self.state_path)
            command.extend(["--state", str(self.state_path)])
        command.extend(args)
        completed = subprocess.run(
            command,
            cwd=self.cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode != 0:
            raise AssertionError(
                "Multiloop command failed.\n"
                f"command: {' '.join(command)}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def run_failure(self, *args: str) -> subprocess.CompletedProcess[str]:
        command = _tool_command()
        if self.state_path is not None:
            assert_disposable_state_path(self.state_path)
            command.extend(["--state", str(self.state_path)])
        command.extend(args)
        completed = subprocess.run(
            command,
            cwd=self.cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode == 0:
            raise AssertionError(f"Multiloop command unexpectedly passed: {' '.join(command)}")
        return completed


def base_state(status: str = "active", current: str | None = "M1") -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "loop": {
            "name": "fixture-loop",
            "displayName": "Fixture Loop",
            "finalGoal": "Verify M1 behavior",
            "iteration": 1,
            "status": status,
            "currentMilestoneId": current,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
        "roadmap": [
            {
                "id": "M1",
                "title": "Core state and CLI inspection",
                "status": "active",
                "goal": "Create the durable JSON state contract and inspection commands.",
                "entryCriteria": ["Requirements are approved"],
                "acceptanceCriteria": ["State contract is durable", "Inspection commands are read-only"],
                "finalGoalContribution": "Provides the base state contract for future loop execution.",
                "learnedFacts": ["Read-only commands should lock without rewriting state"],
                "blockers": [],
                "reviewVerdicts": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
            },
            {
                "id": "M2",
                "title": "Milestone lifecycle and task model",
                "status": "planned",
                "goal": "Add active-milestone task lifecycle later.",
                "entryCriteria": [],
                "acceptanceCriteria": [],
                "finalGoalContribution": "Moves from inspection to execution once M1 is stable.",
                "learnedFacts": [],
                "blockers": [],
                "reviewVerdicts": [],
            },
        ],
        "tasks": [],
        "artifacts": [],
        "agents": {},
        "decisions": [],
        "blockers": [],
    }


def empty_state() -> dict[str, Any]:
    state = base_state(status="active", current=None)
    state["roadmap"] = []
    return state


def blocked_state() -> dict[str, Any]:
    state = base_state(status="blocked", current="M1")
    state["roadmap"][0]["status"] = "blocked"
    state["roadmap"][0]["blockers"] = ["Waiting on release criteria"]
    state["blockers"] = [{"id": "B1", "summary": "Waiting on release criteria"}]
    return state


def accepted_state() -> dict[str, Any]:
    state = base_state(status="accepted", current="M2")
    state["roadmap"][0]["status"] = "accepted"
    state["roadmap"][1]["status"] = "accepted"
    state["artifacts"] = [{"id": "A1", "kind": "validation_report"}]
    return state


def write_state(path: Path, state: dict[str, Any]) -> None:
    assert_disposable_state_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_state(path: Path) -> dict[str, Any]:
    assert_disposable_state_path(path)
    return json.loads(path.read_text(encoding="utf-8"))


def write_swarm_canary(root: Path) -> Path:
    path = root / "swarm" / "canary" / "state.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not valid multiloop json: [\n", encoding="utf-8")
    return path


def assert_read_only(cli: MultiloopCli, state_path: Path, swarm_canary: Path, *args: str) -> str:
    before_state = file_fingerprint(state_path)
    before_swarm = file_fingerprint(swarm_canary)
    completed = cli.run(*args)
    assert file_fingerprint(state_path) == before_state
    assert file_fingerprint(swarm_canary) == before_swarm
    return completed.stdout


def test_fixture_states_cover_empty_active_blocked_and_accepted_status_outputs(tmp_path: Path) -> None:
    cases = {
        "empty": (empty_state(), ["Current milestone: (none)", "Milestones: 0 total"]),
        "active": (base_state(), ["Status: active", "M1 [active]"]),
        "blocked": (blocked_state(), ["Status: blocked", "Blockers: 1", "M1 [blocked]"]),
        "accepted": (accepted_state(), ["Status: accepted", "2 accepted", "Artifacts: 1"]),
    }

    for name, (state, expected_snippets) in cases.items():
        state_path = tmp_path / name / "state.json"
        write_state(state_path, state)
        cli = MultiloopCli(tmp_path, state_path)

        output = cli.run("status").stdout + cli.run("summary").stdout

        for snippet in expected_snippets:
            assert snippet in output


def test_init_creates_m1_state_without_tasks_or_detailed_future_task_graph(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "launch-check" / "state.json"
    swarm_canary = write_swarm_canary(tmp_path)
    before_swarm = file_fingerprint(swarm_canary)
    cli = MultiloopCli(tmp_path, state_path)

    completed = cli.run("init", "--name", "Launch Check", "--final-goal", "Ship M1")

    assert "Created multiloop state:" in completed.stdout
    assert file_fingerprint(swarm_canary) == before_swarm
    state = read_state(state_path)
    assert state["loop"]["name"] == "launch-check"
    assert state["loop"]["iteration"] == 1
    assert state["loop"]["currentMilestoneId"] == "M1"
    assert state["tasks"] == []
    assert [milestone["id"] for milestone in state["roadmap"]] == ["M1", "M2", "M3", "M4", "M5", "M6", "M7"]
    required_milestone_fields = {
        "id",
        "title",
        "goal",
        "status",
        "entryCriteria",
        "acceptanceCriteria",
        "finalGoalContribution",
        "learnedFacts",
        "blockers",
        "reviewVerdicts",
    }
    assert all(required_milestone_fields <= set(milestone) for milestone in state["roadmap"])
    future_milestones = state["roadmap"][1:]
    assert all(milestone["entryCriteria"] == [] for milestone in future_milestones)
    assert all(milestone["acceptanceCriteria"] == [] for milestone in future_milestones)
    assert all(milestone["learnedFacts"] == [] for milestone in future_milestones)
    assert all(milestone["blockers"] == [] for milestone in future_milestones)
    assert all(milestone["reviewVerdicts"] == [] for milestone in future_milestones)


def test_pending_init_fails_if_state_file_is_created_while_waiting_for_lock(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "race-loop" / "state.json"
    lock = StateLock(state_path.with_suffix(".json.lock"), timeout=1.0, poll=0.01)
    lock.acquire()
    cli = MultiloopCli(tmp_path, state_path)
    command = _tool_command() + ["--state", str(state_path), "init", "--name", "Race Loop"]
    pending = subprocess.Popen(
        command,
        cwd=tmp_path,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        write_state(state_path, base_state())
        lock.release()
        stdout, stderr = pending.communicate(timeout=5)
    finally:
        lock.release()
        if pending.poll() is None:
            pending.kill()

    assert pending.returncode != 0
    assert "State file already exists:" in stderr
    assert read_state(state_path)["loop"]["displayName"] == "Fixture Loop"


def test_bash_wrapper_delegates_to_python_tool_when_shell_is_available(tmp_path: Path) -> None:
    if os.name == "nt" and _usable_bash() is None:
        pytest.skip("scripts/multiloop is a bash wrapper; direct Python behavior tests cover Windows without bash")

    state_path = tmp_path / "multiloop" / "wrapper-loop" / "state.json"
    command = _wrapper_command() + ["--state", str(state_path), "init", "--name", "Wrapper Loop"]
    completed = subprocess.run(
        command,
        cwd=tmp_path,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert "Created multiloop state:" in completed.stdout
    assert read_state(state_path)["loop"]["name"] == "wrapper-loop"


def test_create_state_file_rejects_existing_state_inside_lock(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "existing" / "state.json"
    write_state(state_path, base_state())
    replacement = base_state()
    replacement["loop"]["displayName"] = "Replacement"

    with pytest.raises(SystemExit, match="State file already exists:"):
        create_state_file(state_path, replacement)

    assert read_state(state_path)["loop"]["displayName"] == "Fixture Loop"


def test_lock_timeout_and_cleanup_after_handler_errors(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "locked" / "state.json"
    write_state(state_path, base_state())
    lock_path = state_path.with_suffix(".json.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("held", encoding="utf-8")

    with pytest.raises(SystemExit, match="Timed out waiting for lock:"):
        with_locked_state(state_path, lambda state: {"state": state}, write=False, timeout=0.01)

    lock_path.unlink()

    def fail_after_lock(_: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("simulated handler failure")

    with pytest.raises(RuntimeError, match="simulated handler failure"):
        with_locked_state(state_path, fail_after_lock, write=False)

    assert not lock_path.exists()


def test_atomic_write_uses_same_directory_temp_replaces_contents_and_cleans_temp_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "multiloop" / "atomic" / "state.json"
    write_state(state_path, base_state())
    replacement = base_state()
    replacement["loop"]["displayName"] = "Atomic Replacement"
    replace_calls: list[tuple[Path, Path]] = []
    original_replace = state_module.os.replace

    def record_replace(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
        replace_calls.append((Path(src), Path(dst)))
        original_replace(src, dst)

    monkeypatch.setattr(state_module.os, "replace", record_replace)

    save_state(state_path, replacement)

    assert read_state(state_path)["loop"]["displayName"] == "Atomic Replacement"
    assert replace_calls
    assert replace_calls[-1][0].parent == state_path.parent
    assert replace_calls[-1][1] == state_path
    assert list(state_path.parent.glob(".state.json.*.tmp")) == []


def test_failed_atomic_replace_leaves_original_state_and_removes_temp_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "multiloop" / "replace-failure" / "state.json"
    write_state(state_path, base_state())
    before = file_fingerprint(state_path)
    replacement = base_state()
    replacement["loop"]["displayName"] = "Should Not Persist"

    def fail_replace(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
        raise OSError(f"replace failed for {src} -> {dst}")

    monkeypatch.setattr(state_module.os, "replace", fail_replace)

    with pytest.raises(OSError, match="replace failed"):
        save_state(state_path, replacement)

    assert file_fingerprint(state_path) == before
    assert read_state(state_path)["loop"]["displayName"] == "Fixture Loop"
    assert list(state_path.parent.glob(".state.json.*.tmp")) == []


def test_read_only_commands_cover_cli_outputs_without_rewriting_state_or_swarm_canary(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "fixture-loop" / "state.json"
    write_state(state_path, base_state())
    swarm_canary = write_swarm_canary(tmp_path)
    cli = MultiloopCli(tmp_path, state_path)

    checks = [
        (("status",), ["Loop: Fixture Loop", "Status: active", "Current milestone: M1 [active]"]),
        (("roadmap", "show"), ["Roadmap: Fixture Loop", "* M1 [active]", "Goal: Create the durable JSON", "- M2 [planned]"]),
        (("milestone", "list"), ["M1 [active]", "M2 [planned]"]),
        (
            ("milestone", "show", "M1"),
            [
                "Milestone: M1 [active]",
                "Goal: Create the durable JSON",
                "Entry criteria:",
                "- Requirements are approved",
                "Acceptance criteria:",
                "- State contract is durable",
                "Blockers:",
                "(none)",
                "Learned facts:",
                "- Read-only commands should lock without rewriting state",
                "Final-goal contribution: Provides the base state contract",
            ],
        ),
        (("summary",), ["Milestones: 2 total, 1 active", "Tasks: 0", "Artifacts: 0"]),
    ]

    for args, expected_snippets in checks:
        output = assert_read_only(cli, state_path, swarm_canary, *args)
        for snippet in expected_snippets:
            assert snippet in output


def test_invalid_state_failures_report_invalid_json_missing_fields_bad_shapes_and_bad_current_milestone(
    tmp_path: Path,
) -> None:
    invalid_json_path = tmp_path / "invalid-json" / "state.json"
    invalid_json_path.parent.mkdir(parents=True)
    invalid_json_path.write_text("{not json", encoding="utf-8")
    invalid_json = MultiloopCli(tmp_path, invalid_json_path).run_failure("status")
    assert "Invalid JSON" in invalid_json.stderr

    missing_field_path = tmp_path / "missing-field" / "state.json"
    missing_field = base_state()
    del missing_field["tasks"]
    write_state(missing_field_path, missing_field)
    missing_result = MultiloopCli(tmp_path, missing_field_path).run_failure("status")
    assert "$.tasks: missing required field" in missing_result.stderr

    missing_iteration_path = tmp_path / "missing-iteration" / "state.json"
    missing_iteration = base_state()
    del missing_iteration["loop"]["iteration"]
    write_state(missing_iteration_path, missing_iteration)
    missing_iteration_result = MultiloopCli(tmp_path, missing_iteration_path).run_failure("status")
    assert "$.loop.iteration: missing required field" in missing_iteration_result.stderr

    missing_roadmap_detail_path = tmp_path / "missing-roadmap-detail" / "state.json"
    missing_roadmap_detail = base_state()
    del missing_roadmap_detail["roadmap"][0]["finalGoalContribution"]
    write_state(missing_roadmap_detail_path, missing_roadmap_detail)
    missing_roadmap_detail_result = MultiloopCli(tmp_path, missing_roadmap_detail_path).run_failure("milestone", "show", "M1")
    assert "$.roadmap[0].finalGoalContribution: missing required field" in missing_roadmap_detail_result.stderr

    bad_shape_path = tmp_path / "bad-shape" / "state.json"
    bad_shape = base_state()
    bad_shape["agents"] = []
    write_state(bad_shape_path, bad_shape)
    bad_shape_result = MultiloopCli(tmp_path, bad_shape_path).run_failure("summary")
    assert "$.agents: expected object" in bad_shape_result.stderr

    bad_current_path = tmp_path / "bad-current" / "state.json"
    bad_current = base_state()
    bad_current["loop"]["currentMilestoneId"] = "M99"
    write_state(bad_current_path, bad_current)
    bad_current_result = MultiloopCli(tmp_path, bad_current_path).run_failure("roadmap", "show")
    assert "$.loop.currentMilestoneId: unknown milestone id 'M99'" in bad_current_result.stderr


def test_default_discovery_fails_clearly_for_zero_and_multiple_states(tmp_path: Path) -> None:
    no_state = MultiloopCli(tmp_path).run_failure("status")
    assert "No multiloop state found. Pass --state or --name." in no_state.stderr

    first = tmp_path / "multiloop" / "one" / "state.json"
    second = tmp_path / "multiloop" / "two" / "state.json"
    write_state(first, base_state())
    other_state = deepcopy(base_state())
    other_state["loop"]["name"] = "two"
    write_state(second, other_state)

    multiple = MultiloopCli(tmp_path).run_failure("summary")
    assert "Multiple multiloop states found. Pass --state or --name." in multiple.stderr


def test_name_based_default_discovery_selects_single_state_without_swarm_access(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "named-loop" / "state.json"
    state = base_state()
    state["loop"]["name"] = "named-loop"
    state["loop"]["displayName"] = "Named Loop"
    write_state(state_path, state)
    swarm_canary = write_swarm_canary(tmp_path)
    cli = MultiloopCli(tmp_path)

    before_state = file_fingerprint(state_path)
    before_swarm = file_fingerprint(swarm_canary)
    completed = cli.run("--name", "Named Loop", "status")

    assert "Loop: Named Loop" in completed.stdout
    assert file_fingerprint(state_path) == before_state
    assert file_fingerprint(swarm_canary) == before_swarm
