"""The seam map (MC-1819) and the hot-seam signal (MC-1822).

Both are INFORMATION for the architect's judgment, and these tests pin that as
hard as they pin the mechanism: the plan gate checks only that `## Seams`
EXISTS, never what is in it, and the hot-seam signal reports a seam without
touching the plan. The measured need was real — 52% of conversation's files
were touched by 2+ tasks and every major the post-merge sweep found sat on an
unmapped seam — but no overlap number rejects a plan, and the engine inserts no
checkpoint task.
"""
from __future__ import annotations

from helpers import base_state, create_team, read_state, task, write_state
from sprintengine_core.tool.seams import (
    HOT_SEAM_OWNER_THRESHOLD,
    hot_seam_signals,
    plan_seam_section_warnings,
    published_seam_owners,
    record_seam_signals,
    seam_key,
)


def published(task_id: str, paths: list[str], status: str = "done") -> dict:
    record = task(task_id, f"Task {task_id}", "developer", status=status)
    record["evidence"]["diffs"] = [
        {"path": path, "status": "modified", "hunks": []} for path in paths
    ]
    return record


# --- the plan section check (MC-1819) -----------------------------------------


def test_multi_task_plan_without_a_seams_section_warns(tmp_path) -> None:
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n\n## Approach\n\nBuild it.\n", encoding="utf-8")
    state = base_state("s", [task("T1", "A", "developer"), task("T2", "B", "developer")])
    warnings = plan_seam_section_warnings(state, plan)
    assert len(warnings) == 1 and "plan_seam_section_missing" in warnings[0]


def test_a_seams_section_satisfies_the_check_whatever_it_says(tmp_path) -> None:
    """Presence only. `None` with a reason is a complete, valid seam map —
    judging the content belongs to the human approving the plan, and a quota
    here is exactly what the owner philosophy rules out."""
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n\n## Seams\n\nNone — the two tasks share no file.\n", encoding="utf-8")
    state = base_state("s", [task("T1", "A", "developer"), task("T2", "B", "developer")])
    assert plan_seam_section_warnings(state, plan) == []


def test_single_task_plan_is_never_asked_for_seams(tmp_path) -> None:
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n", encoding="utf-8")
    state = base_state("s", [task("T1", "A", "developer")])
    assert plan_seam_section_warnings(state, plan) == []


def test_canceled_tasks_do_not_make_a_plan_multi_task(tmp_path) -> None:
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n", encoding="utf-8")
    state = base_state(
        "s", [task("T1", "A", "developer"), task("T2", "B", "developer", status="canceled")]
    )
    assert plan_seam_section_warnings(state, plan) == []


def test_a_missing_plan_file_is_not_this_checks_problem(tmp_path) -> None:
    state = base_state("s", [task("T1", "A", "developer"), task("T2", "B", "developer")])
    assert plan_seam_section_warnings(state, tmp_path / "absent.md") == []


def test_seams_heading_matches_case_insensitively_and_with_trailing_text(tmp_path) -> None:
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n\n## Seams and contracts\n\n- one\n", encoding="utf-8")
    state = base_state("s", [task("T1", "A", "developer"), task("T2", "B", "developer")])
    assert plan_seam_section_warnings(state, plan) == []


# --- seam identity ------------------------------------------------------------


def test_an_ipc_triple_is_one_seam() -> None:
    """The T4/T5/T9 shape: a main handler, a preload bridge, and a shared api
    are three files but ONE contract. Keying them separately is why three tasks
    on one contract looked like three unrelated single-owner files."""
    assert seam_key("src/main/review-ipc.ts") == "ipc:review"
    assert seam_key("src/preload/review.ts") == "ipc:review"
    assert seam_key("src/shared/review.ts") == "ipc:review"


def test_an_ordinary_file_is_its_own_seam() -> None:
    assert seam_key("src/renderer/src/components/AgentChatView.tsx") == (
        "src/renderer/src/components/AgentChatView.tsx"
    )
    assert seam_key("") == ""


# --- the hot-seam signal (MC-1822) --------------------------------------------


def test_two_owners_are_not_hot() -> None:
    state = base_state(
        "s",
        [
            published("T1", ["src/renderer/App.tsx"]),
            published("T2", ["src/renderer/App.tsx"]),
        ],
    )
    assert published_seam_owners(state)["src/renderer/App.tsx"] == ["T1", "T2"]
    assert hot_seam_signals(state) == []


def test_the_third_landing_raises_the_signal() -> None:
    state = base_state(
        "s",
        [
            published("T1", ["src/renderer/App.tsx"]),
            published("T2", ["src/renderer/App.tsx"]),
            published("T3", ["src/renderer/App.tsx"]),
        ],
    )
    signals = hot_seam_signals(state)
    assert len(signals) == 1
    assert signals[0]["seam"] == "src/renderer/App.tsx"
    assert signals[0]["ownerTaskIds"] == ["T1", "T2", "T3"]
    assert signals[0]["landedCount"] == HOT_SEAM_OWNER_THRESHOLD
    # The signal ASKS; it does not decide. "Consider" and "you decide" are the
    # contract — the engine never inserts the checkpoint task itself.
    assert "consider planning a checkpoint review task" in signals[0]["question"].lower()


def test_three_tasks_across_one_ipc_contract_are_hot() -> None:
    state = base_state(
        "s",
        [
            published("T4", ["src/main/review-ipc.ts"]),
            published("T5", ["src/preload/review.ts"]),
            published("T9", ["src/shared/review.ts"]),
        ],
    )
    signals = hot_seam_signals(state)
    assert [signal["seam"] for signal in signals] == ["ipc:review"]
    assert signals[0]["ownerTaskIds"] == ["T4", "T5", "T9"]


def test_unpublished_tasks_do_not_count() -> None:
    """Planned ownership is not landed change: `ownedPaths` are
    documented-unreliable, so the signal reads what a task actually published."""
    state = base_state(
        "s",
        [
            published("T1", ["src/a.ts"]),
            published("T2", ["src/a.ts"]),
            published("T3", ["src/a.ts"], status="in_progress"),
        ],
    )
    assert hot_seam_signals(state) == []


def test_a_signal_is_raised_once_not_on_every_later_publish() -> None:
    state = base_state(
        "s",
        [
            published("T1", ["src/a.ts"]),
            published("T2", ["src/a.ts"]),
            published("T3", ["src/a.ts"]),
        ],
    )
    record_seam_signals(state, hot_seam_signals(state), "2026-07-27T00:00:00Z")
    assert len(state["seamSignals"]) == 1
    # A fourth landing on an already-reported seam stays quiet: the architect
    # was told, and repeating it every publish is noise, not signal.
    state["tasks"].append(published("T4", ["src/a.ts"]))
    assert hot_seam_signals(state) == []


def test_publishing_raises_the_signal_and_never_blocks_the_publish(tmp_path) -> None:
    fixture = create_team(tmp_path, "hot-seam-publish", [])
    state = read_state(fixture.state_path)
    state["tasks"] = [
        published("T1", ["src/a.ts"]),
        published("T2", ["src/a.ts"]),
        task("T3", "Third landing", "developer", status="in_progress", owner="developer-1"),
    ]
    # Logged evidence, not seeded diffs: `task publish` recaptures diff evidence
    # from git and this fixture has no repo, so the diff array is rewritten to
    # empty. `touchedFiles` is what an agent's `task.log` leaves behind and it
    # survives the recapture — the seam scan reads both.
    state["tasks"][2]["evidence"]["touchedFiles"] = ["src/a.ts"]
    state["tasks"][2]["startedAt"] = "2026-07-27T00:00:00Z"
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = ["architect", "developer"]
    write_state(fixture.state_path, state)

    result = fixture.cli.run(
        "task", "publish", "--task-id", "T3", "--id", "developer-1",
        "--summary", "Third task on this file.", "--no-changes-ok",
    )
    assert result["ok"] is True
    assert [signal["seam"] for signal in result["seamSignals"]] == ["src/a.ts"]

    # The architect is told through the planner-routed triage surface, which is
    # where planning decisions are made — and told as information, with the
    # decision left open.
    triage = fixture.cli.run("triage", "needs-input", "--id", "architect-1")
    assert "src/a.ts" in triage["prompt"]
    assert "the engine never adds tasks" in triage["prompt"]
    assert [entry["seam"] for entry in triage["seamSignals"]] == ["src/a.ts"]

    # And nothing about the plan changed: no task was inserted.
    assert len(read_state(fixture.state_path)["tasks"]) == 3
