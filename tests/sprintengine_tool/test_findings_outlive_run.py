"""Findings become structured objects that outlive the run (MC-1823).

Two failures, one item. First, the `findings` array was empty in all 33 task
records across the three runs merged 2026-07-23 even where task summaries
textually reported findings — the channel existed and nothing downstream ever
asked it a question, so T10's chip-ordering finding survived only as prose in a
comment and had to be hand-rescued three days later (item 1816). The run summary
now carries a flattened, attributed roll-up, including which task was filed to
answer each finding.

Second, T15's evidence `results` array was corrupted char-by-char
("o","k"," ","-",…): a bare string reached a `list()`/`extend()` that spread it.
That is fixed at both ends — the MCP payload adapter and the evidence writer —
so it cannot come back through a new caller or a client that ignores the schema.
"""
from __future__ import annotations

import pytest

from helpers import base_state, create_team, read_state, task, write_state
from sprintengine_core.tool.plans import build_run_summary, collect_run_findings
from sprintengine_core.tool.tasks import coerce_evidence_values, normalize_from_finding
from sprintengine_mcp.payloads import command_payload_to_namespace


def finding(finding_id: str, severity: str = "high", kind: str = "code_bug") -> dict:
    return {
        "id": finding_id,
        "kind": kind,
        "severity": severity,
        "area": "frontend",
        "status": "open",
        "title": f"Finding {finding_id}",
    }


# --- the bare-string spread ---------------------------------------------------


def test_a_bare_string_is_wrapped_not_shredded() -> None:
    assert coerce_evidence_values("ok - suite green") == ["ok - suite green"]
    assert coerce_evidence_values(["a", "b"]) == ["a", "b"]
    assert coerce_evidence_values(None) == []
    assert coerce_evidence_values("   ") == []


def test_the_mcp_log_payload_no_longer_spreads_a_bare_string(tmp_path) -> None:
    """The T15 shape exactly: a client sends `result` as a string where the
    schema says array. It must arrive as one result, not eleven characters."""
    namespace = command_payload_to_namespace(
        "sprintengine.task.log",
        tmp_path / "run.yaml",
        {"taskId": "T1", "id": "tester-1", "result": "ok - all green", "command": "npm test"},
        None,
    )
    assert namespace.result == ["ok - all green"]
    assert namespace.command == ["npm test"]
    assert namespace.file == []


def test_the_mcp_finding_payload_accepts_a_single_object(tmp_path) -> None:
    namespace = command_payload_to_namespace(
        "sprintengine.task.log",
        tmp_path / "run.yaml",
        {"taskId": "T1", "id": "tester-1", "findingJson": finding("T1-F1")},
        None,
    )
    assert len(namespace.finding_json) == 1
    assert '"id": "T1-F1"' in namespace.finding_json[0]


def test_the_evidence_writer_wraps_a_bare_string_end_to_end(tmp_path) -> None:
    fixture = create_team(tmp_path, "evidence-bare-string", [])
    state = read_state(fixture.state_path)
    state["tasks"] = [task("T1", "Audit", "developer", status="in_progress", owner="developer-1")]
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = ["developer"]
    write_state(fixture.state_path, state)

    fixture.cli.run(
        "task", "log", "--task-id", "T1", "--id", "developer-1",
        "--result", "ok - 12 assertions passed",
    )
    results = read_state(fixture.state_path)["tasks"][0]["evidence"]["results"]
    assert results == ["ok - 12 assertions passed"]
    # The corruption signature: single characters as separate entries.
    assert not any(len(entry) == 1 for entry in results)


def test_a_store_already_holding_a_bare_string_reads_back_whole() -> None:
    from sprintengine_core.tool.tasks import ensure_evidence

    record = task("T1", "Audit", "developer")
    record["evidence"]["results"] = "ok - legacy string"
    assert ensure_evidence(record)["results"] == ["ok - legacy string"]


# --- findings that outlive the run --------------------------------------------


def test_findings_are_collected_from_self_reports_and_reviewer_assessments() -> None:
    owner_reported = task("T1", "Build", "developer", status="done")
    owner_reported["feedback"] = {
        "agentId": "developer-1",
        "capturedAt": "2026-07-27T01:00:00Z",
        "findings": [finding("T1-F1", severity="medium")],
    }
    reviewed = task("T2", "Surface", "frontend", status="done")
    reviewed["feedbackAssessments"] = [
        {
            "agentId": "tester-1",
            "capturedAt": "2026-07-27T02:00:00Z",
            "findings": [finding("T2-F1", severity="critical")],
        }
    ]
    findings = collect_run_findings(base_state("s", [owner_reported, reviewed]))

    assert [entry["id"] for entry in findings] == ["T1-F1", "T2-F1"]
    assert findings[0]["origin"] == "self_report"
    assert findings[0]["taskId"] == "T1"
    # Attribution matters: a reviewer's finding against another task must not
    # read as that task's owner reporting on itself.
    assert findings[1]["origin"] == "reviewer_assessment"
    assert findings[1]["reportedBy"] == "tester-1"
    assert findings[1]["severity"] == "critical"


def test_the_run_summary_carries_findings_and_a_severity_tally() -> None:
    audited = task("T1", "Build", "developer", status="done")
    audited["feedback"] = {
        "agentId": "developer-1",
        "findings": [finding("T1-F1", severity="high"), finding("T1-F2", severity="low")],
    }
    summary = build_run_summary(base_state("s", [audited]))
    assert [entry["id"] for entry in summary["findings"]] == ["T1-F1", "T1-F2"]
    assert summary["findingsBySeverity"] == {"high": 1, "low": 1}


def test_a_run_with_no_findings_reports_an_empty_roll_up() -> None:
    summary = build_run_summary(base_state("s", [task("T1", "Build", "developer", status="done")]))
    assert summary["findings"] == []
    assert summary["findingsBySeverity"] == {}


# --- the reviewer task-filing channel -----------------------------------------


def test_from_finding_requires_both_halves() -> None:
    assert normalize_from_finding("T1", "T1-F1", "T9") == {"taskId": "T1", "findingId": "T1-F1"}
    assert normalize_from_finding(None, None, "T9") is None
    # Half a pointer resolves to nothing, so it is rejected rather than stored.
    with pytest.raises(SystemExit):
        normalize_from_finding("T1", "", "T9")
    with pytest.raises(SystemExit):
        normalize_from_finding("", "T1-F1", "T9")


def test_a_filed_task_links_back_to_the_finding_it_answers() -> None:
    audited = task("T1", "Build", "developer", status="done")
    audited["feedback"] = {"agentId": "reviewer-1", "findings": [finding("T1-F1")]}
    filed = task("T7", "Fix what the review found", "developer")
    filed["fromFinding"] = {"taskId": "T1", "findingId": "T1-F1"}

    findings = collect_run_findings(base_state("s", [audited, filed]))
    assert findings[0]["filedTaskIds"] == ["T7"]


def test_an_unfiled_finding_reports_no_filed_tasks() -> None:
    audited = task("T1", "Build", "developer", status="done")
    audited["feedback"] = {"agentId": "reviewer-1", "findings": [finding("T1-F1")]}
    assert collect_run_findings(base_state("s", [audited]))[0]["filedTaskIds"] == []


def test_the_escalation_carries_the_finding_id_to_the_architect(tmp_path) -> None:
    """End to end on the channel: a reviewer whose finding is too large to fix
    forward escalates naming the finding, and the architect's triage surface
    tells it which finding and how to file the follow-up task."""
    fixture = create_team(tmp_path, "filing-channel", [])
    state = read_state(fixture.state_path)
    reviewing = task("T2", "Review the seam", "developer", status="in_progress", owner="developer-1")
    reviewing["feedback"] = {"agentId": "developer-1", "findings": [finding("T2-F1", severity="critical")]}
    state["tasks"] = [task("T1", "Build", "developer", status="done"), reviewing]
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = ["architect", "developer"]
    write_state(fixture.state_path, state)

    fixture.cli.run(
        "task", "status", "--task-id", "T2", "--status", "needs_input", "--id", "developer-1",
        "--needs-input-kind", "architect",
        "--needs-input-finding-id", "T2-F1",
        "--needs-input-question", "T2-F1 is a rewrite of the store slice; too large to fix here.",
    )
    assert read_state(fixture.state_path)["tasks"][1]["needsInput"]["findingId"] == "T2-F1"

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect-1")
    assert "Finding id: T2-F1" in triage["prompt"]
    assert "--from-finding-id" in triage["prompt"]
    # Done stays terminal: the channel files a NEW task, it never reopens T1.
    assert "never reopen" in triage["prompt"].lower()

    filed = fixture.cli.run(
        "plan", "add-task",
        "--title", "Rewrite the store slice", "--role", "developer",
        "--description", "Answer T2-F1.", "--acceptance", "The slice is rewritten.",
        "--from-finding-task-id", "T2", "--from-finding-id", "T2-F1",
    )
    assert filed["task"]["fromFinding"] == {"taskId": "T2", "findingId": "T2-F1"}

    final = read_state(fixture.state_path)
    reported = next(entry for entry in collect_run_findings(final) if entry["id"] == "T2-F1")
    assert reported["filedTaskIds"] == [filed["task"]["id"]]
