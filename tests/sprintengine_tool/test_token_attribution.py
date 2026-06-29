from __future__ import annotations

import copy
import json

from helpers import create_team, task
from sprintengine_core import store as folder_store
from sprintengine_mcp import SprintEngineMcpServer


def sample(agent_id: str, cli_session_id: str, sampled_at: str, model: str, **usage: int) -> dict:
    per_model = {"model": model, "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    per_model.update(usage)
    return {
        "agentId": agent_id,
        "cli": "claude-code",
        "cliSessionId": cli_session_id,
        "perModel": [per_model],
        "sampledAt": sampled_at,
    }


def reviewed_task() -> dict:
    return {
        "id": "T1",
        "title": "Implement feature",
        "role": "developer",
        "status": "done",
        "ownerAgentId": None,
        "lastImplementedByAgentId": "dev-1",
        "startedAt": "2026-06-28T10:00:30Z",
        "completedAt": "2026-06-28T10:09:00Z",
        "qualityGates": [
            {
                "id": "code_reviewer",
                "role": "code_reviewer",
                "status": "approved",
                "attempts": [
                    {
                        "id": "GA-001",
                        "claimedBy": "rev-1",
                        "role": "code_reviewer",
                        "startedAt": "2026-06-28T10:06:00Z",
                        "completedAt": "2026-06-28T10:08:30Z",
                        "status": "approved",
                        "verdict": "approved",
                    }
                ],
            }
        ],
    }


def test_developer_and_reviewer_attributed_separately_and_sum_to_task_total() -> None:
    samples = [
        # developer session D1: baseline before claim, then post-implementation
        # Stop (which lands before the reviewer claims, the dev window's end).
        sample("dev-1", "D1", "2026-06-28T10:00:00Z", "opus", input=0),
        sample("dev-1", "D1", "2026-06-28T10:05:00Z", "opus", input=100, output=10, cacheRead=50, cacheCreation=5),
        # reviewer session R1: baseline before claim, then the closing Stop — which
        # fires AFTER completedAt (10:08:30), because the verdict is recorded
        # mid-turn and the flush drains the review's work after it.
        sample("rev-1", "R1", "2026-06-28T10:05:30Z", "opus", input=0),
        sample("rev-1", "R1", "2026-06-28T10:09:00Z", "opus", input=30, output=5, cacheRead=10),
    ]
    t = reviewed_task()
    folder_store.attribute_task_token_usage(t, samples)

    # Developer window ends at the first review claim, so it excludes the review
    # period: it is exactly the developer session's delta.
    dev = t["tokenUsage"]["developer"]
    assert dev["agentId"] == "dev-1"
    assert dev["partial"] is False
    assert dev["total"] == {"input": 100, "output": 10, "cacheRead": 50, "cacheCreation": 5}

    attempt = t["qualityGates"][0]["attempts"][0]["tokenUsage"]
    assert attempt["partial"] is False
    assert attempt["total"] == {"input": 30, "output": 5, "cacheRead": 10, "cacheCreation": 0}

    # Task total = developer + every attempt.
    assert t["tokenUsage"]["total"] == {"input": 130, "output": 15, "cacheRead": 60, "cacheCreation": 5}
    assert t["tokenUsage"]["partial"] is False


def test_gate_attempt_end_uses_drain_after_completedAt_not_baseline() -> None:
    # AC3 regression: an agent session reused across dispatches. The reviewer's
    # only sample after it claims the gate is the closing Stop, which lands AFTER
    # completedAt (the verdict is recorded mid-turn). The window END must read
    # that post-boundary drain, not the pre-claim baseline — otherwise the delta
    # silently collapses to 0.
    t = reviewed_task()  # attempt window [10:06:00, 10:08:30]
    samples = [
        # Prior dispatch's work on this reused reviewer session (the baseline).
        sample("rev-1", "R1", "2026-06-28T10:04:00Z", "opus", input=200, output=0, cacheRead=0),
        # The only post-claim sample is the closing Stop, AFTER completedAt.
        sample("rev-1", "R1", "2026-06-28T10:09:00Z", "opus", input=230, output=5, cacheRead=10),
    ]
    folder_store.attribute_task_token_usage(t, samples)
    attempt = t["qualityGates"][0]["attempts"][0]["tokenUsage"]
    # delta = drain(230/5/10) - baseline(200/0/0) = 30/5/10, not zero.
    assert attempt["partial"] is False
    assert attempt["total"] == {"input": 30, "output": 5, "cacheRead": 10, "cacheCreation": 0}


def test_gate_attempt_partial_when_closing_flush_has_not_landed() -> None:
    # The reviewer recorded its verdict but has not Stopped yet, so there is no
    # flush at-or-after completedAt: report partial:no_sample, never a clean 0.
    t = reviewed_task()
    samples = [
        sample("rev-1", "R1", "2026-06-28T10:04:00Z", "opus", input=200),
        # An in-window sample (a mid-review flush) but nothing draining past END.
        sample("rev-1", "R1", "2026-06-28T10:07:00Z", "opus", input=210),
    ]
    folder_store.attribute_task_token_usage(t, samples)
    attempt = t["qualityGates"][0]["attempts"][0]["tokenUsage"]
    assert attempt["partial"] is True
    assert attempt["reason"] == "no_sample"


def test_reworked_task_developer_window_flagged_partial_not_guessed() -> None:
    t = reviewed_task()
    t["qualityGates"][0]["attempts"][0]["verdict"] = "changes_requested"
    t["qualityGates"][0]["attempts"][0]["status"] = "changes_requested"
    samples = [
        sample("dev-1", "D1", "2026-06-28T10:00:00Z", "opus", input=0),
        sample("dev-1", "D1", "2026-06-28T10:05:00Z", "opus", input=100, output=10),
        sample("rev-1", "R1", "2026-06-28T10:05:30Z", "opus", input=0),
        sample("rev-1", "R1", "2026-06-28T10:09:00Z", "opus", input=30, output=5),
    ]
    folder_store.attribute_task_token_usage(t, samples)
    dev = t["tokenUsage"]["developer"]
    assert dev["partial"] is True
    assert dev["reason"] == "reworked_multi_episode"
    # Still reported, not zeroed.
    assert dev["total"]["input"] == 100
    assert t["tokenUsage"]["partial"] is True


def test_missing_samples_mark_window_partial() -> None:
    t = reviewed_task()
    # No samples at all: every window is partial with no fabricated total.
    folder_store.attribute_task_token_usage(t, [])
    assert t["tokenUsage"]["developer"]["partial"] is True
    assert t["tokenUsage"]["developer"]["reason"] == "no_sample"
    assert t["tokenUsage"]["developer"]["total"] == {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    assert t["qualityGates"][0]["attempts"][0]["tokenUsage"]["partial"] is True


def test_resume_within_window_sums_segments_from_zero() -> None:
    # Developer resumes mid-window: session D1 then D2. D2's cumulative starts at
    # 0, so its segment counts from 0 rather than subtracting across sessions.
    samples = [
        sample("dev-1", "D1", "2026-06-28T10:00:00Z", "opus", input=0),
        sample("dev-1", "D1", "2026-06-28T10:02:00Z", "opus", input=40, output=4),
        sample("dev-1", "D2", "2026-06-28T10:05:00Z", "opus", input=70, output=6),
    ]
    t = reviewed_task()
    folder_store.attribute_task_token_usage(t, samples)
    dev = t["tokenUsage"]["developer"]
    # D1 segment: 40/4 (from 0 baseline) + D2 segment: 70/6 (from 0) = 110/10.
    assert dev["total"] == {"input": 110, "output": 10, "cacheRead": 0, "cacheCreation": 0}
    assert dev["partial"] is False


def actor() -> dict:
    return {"id": "multicode-app", "role": "user", "authenticated": True, "mcpAuthorized": True}


def test_sample_tool_persists_and_projection_attributes(tmp_path) -> None:
    card = task("T1", "Implement feature", "developer", "in_progress", owner="dev-1")
    fixture = create_team(tmp_path, "attribution-run", [card])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    result = server.call_tool(
        "sprintengine.agent.sample_token_usage",
        {
            "statePath": str(fixture.state_path),
            "agentId": "dev-1",
            "cli": "claude-code",
            "cliSessionId": "D1",
            "perModel": [{"model": "opus", "input": 100, "output": 10, "cacheRead": 0, "cacheCreation": 0}],
            "sampledAt": "2026-06-28T10:05:00Z",
        },
        actor(),
    )
    assert result.get("ok"), result

    # The sample is persisted to the append-only log.
    records = folder_store.read_jsonl_file(fixture.team_dir / folder_store.TOKEN_SAMPLE_FILE)
    assert len(records) == 1 and records[0]["cliSessionId"] == "D1"

    # build_projection attaches a tokenUsage block to every task.
    projection = json.loads((fixture.team_dir / "projection.json").read_text())
    t1 = next(item for item in projection["tasks"] if item["id"] == "T1")
    assert "tokenUsage" in t1
    assert "developer" in t1["tokenUsage"]


def test_attribution_does_not_mutate_input_samples() -> None:
    samples = [sample("dev-1", "D1", "2026-06-28T10:05:00Z", "opus", input=100)]
    snapshot = copy.deepcopy(samples)
    folder_store.attribute_task_token_usage(reviewed_task(), samples)
    assert samples == snapshot
