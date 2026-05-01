from __future__ import annotations

import json

from helpers import create_team, task
import swarm_core.tool as swarm_tool
from swarm_core.audit import append_audit_event, audit_log_path, build_audit_event, record_audit_event
from swarm_core.health import CORE_VERSION, build_health_report


def test_load_state_uses_json_fast_path_without_yaml_parser(tmp_path, monkeypatch) -> None:
    state_path = tmp_path / "state.yaml"
    state_path.write_text(
        json.dumps(
            {
                "swarm": {"name": "json-fast-path"},
                "tasks": [],
                "agents": {},
                "events": [],
                "artifacts": [],
                "roles": {},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    def fail_yaml_load(_raw):
        raise AssertionError("JSON state should not use the YAML parser")

    monkeypatch.setattr(swarm_tool.yaml, "safe_load", fail_yaml_load)

    state = swarm_tool.load_state(state_path)

    assert state["swarm"]["name"] == "json-fast-path"


def test_audit_event_contains_required_operation_fields_and_omits_error_detail(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "audit",
        [task("T1", "Implement audit", "developer", "in_progress", owner="developer-fixture")],
    )

    event = build_audit_event(
        operation_name="task.status",
        actor="developer-fixture",
        result="failure",
        duration_ms=12,
        state_path=fixture.state_path,
        task_id="T1",
        artifact_id="A1",
        error=RuntimeError("TERMINAL_OUTPUT_SECRET should not be recorded"),
    )

    assert event["schema_version"] == 1
    assert event["recorded_at"].endswith("Z")
    assert event["operation_name"] == "task.status"
    assert event["actor"] == "developer-fixture"
    assert event["team_slug"] == "audit"
    assert len(event["state_digest"]) == 64
    assert event["task_id"] == "T1"
    assert event["artifact_id"] == "A1"
    assert event["result"] == "failure"
    assert event["duration_ms"] == 12
    assert event["error_class"] == "RuntimeError"
    assert "TERMINAL_OUTPUT_SECRET" not in json.dumps(event, sort_keys=True)


def test_audit_events_append_jsonl_under_team_metrics(tmp_path) -> None:
    fixture = create_team(tmp_path, "audit-jsonl", [task("T1", "Implement audit", "developer")])

    first = record_audit_event(
        fixture.state_path,
        operation_name="task.next",
        actor="developer-fixture",
        result="success",
        duration_ms=3,
        task_id="T1",
    )
    second = build_audit_event(
        operation_name="health.check",
        actor="developer-fixture",
        result="success",
        duration_ms=1,
        state_path=fixture.state_path,
    )
    output_path = append_audit_event(fixture.state_path, second)

    assert output_path == audit_log_path(fixture.state_path)
    rows = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
    assert rows[0] == first
    assert rows[1]["operation_name"] == "health.check"
    assert output_path.parent == fixture.team_dir / "metrics"


def test_health_report_includes_version_schema_root_backend_and_capabilities(tmp_path) -> None:
    fixture = create_team(tmp_path, "health", [task("T1", "Implement health", "developer")])

    report = build_health_report(
        state_path=fixture.state_path,
        allowed_root=tmp_path,
        backend_mode="direct-core",
    )

    assert report == {
        "version": CORE_VERSION,
        "schemaVersion": 1,
        "backendMode": "direct-core",
        "allowedRoot": {
            "configured": True,
            "allowed": True,
            "root": str(tmp_path.resolve()),
        },
        "capabilities": {"read": True, "write": True},
    }


def test_health_report_denies_state_outside_allowed_root(tmp_path) -> None:
    fixture = create_team(tmp_path, "health-denied", [task("T1", "Implement health", "developer")])
    other_root = tmp_path / "other-root"
    other_root.mkdir()

    report = build_health_report(state_path=fixture.state_path, allowed_root=other_root)

    assert report["allowedRoot"] == {
        "configured": True,
        "allowed": False,
        "root": str(other_root.resolve()),
    }
