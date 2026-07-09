"""The task-context prompt an owner receives when it claims or resumes a task.

Replaces the MC-1542-deleted `test_review_dedup.py`. Concurrent-reviewer finding
dedup ("this gate confirms C3 filed by that gate") described a world with several
reviewers verdicting one task at once. There is now exactly one reviewer of a
task: its owner. Nothing writes `gateId` or `requiredActions` onto a comment any
more, so no prompt can carry per-gate sections or shared findings.

What survives is Flow 5: human feedback reopens a task, the owner claims it back
via `task.next`, and `build_rework_prompt` hands it the open feedback as its
rework queue. These tests pin that prompt's shape.
"""

from __future__ import annotations

from pathlib import Path

from helpers import task
from sprintengine_core.tool.comments import comment_prompt_line
from sprintengine_core.tool.phase_prompts import build_rework_prompt


def feedback_comment(
    comment_id: str,
    actor: str,
    body: str,
    *,
    created_at: str,
    comment_type: str = "review_feedback",
    artifact_id: str | None = None,
) -> dict:
    """A comment shaped the way the engine actually writes feedback today:
    `artifact request-changes` and architect notes, keyed by artifact, never gate."""
    data: dict = {"status": "open"}
    if artifact_id:
        data["artifactId"] = artifact_id
        data["artifactStatus"] = "changes_requested"
    return {
        "id": comment_id,
        "type": comment_type,
        "actor": actor,
        "authorAgentId": actor,
        "authorRole": actor.rsplit("-", 1)[0],
        "source": "agent",
        "body": body,
        "createdAt": created_at,
        "data": data,
    }


def reopened_task(comments: list[dict]) -> dict:
    record = task("T1", "Implement reviewed feature", "developer", "in_progress", owner="developer-1")
    record["evidence"] = {"summary": "Implemented.", "touchedFiles": [], "commandsRan": [], "results": []}
    record["comments"] = comments
    return record


def state_path(tmp_path) -> Path:
    return tmp_path / ".multi-code" / "sprintengine" / "rework-team" / "run.yaml"


def test_rework_prompt_hands_the_owner_its_open_feedback_newest_first(tmp_path) -> None:
    record = reopened_task([
        feedback_comment(
            "C1",
            "user",
            "Changes requested for artifact A2 (Mockup): needs a loading state.",
            created_at="2026-05-17T00:01:00Z",
            artifact_id="A2",
        ),
        feedback_comment(
            "C2",
            "architect-1",
            "Scope question raised on the task.",
            created_at="2026-05-17T00:02:00Z",
            comment_type="architect_feedback",
        ),
    ])

    prompt = build_rework_prompt(state_path(tmp_path), record)

    assert "Task: `T1` - Implement reviewed feature" in prompt
    assert "Status: `in_progress`" in prompt
    # Newest first, and both feedback kinds reach the queue.
    assert prompt.index("Scope question raised on the task.") < prompt.index("needs a loading state.")
    assert "Use the open feedback as the rework queue." in prompt


def test_rework_prompt_has_no_per_gate_sections_and_no_shared_findings(tmp_path) -> None:
    """No comment carries a `gateId` or `requiredActions` any more, so the
    per-gate grouping and the shared-findings section can never fire."""
    record = reopened_task([
        feedback_comment(
            "C1",
            "security-a",
            "Null deref on empty config.",
            created_at="2026-05-17T00:01:00Z",
        ),
        feedback_comment(
            "C2",
            "security-a",
            "Crash is reachable from unauthenticated input.",
            created_at="2026-05-17T00:02:00Z",
        ),
    ])

    prompt = build_rework_prompt(state_path(tmp_path), record)

    # Flat, newest-first. No gate grouping, no shared-finding dedup, no
    # requiredActions — none of those concepts survive a single-owner run.
    assert "## Open Feedback (newest first)" in prompt
    assert "### Gate `" not in prompt
    assert "### Other Feedback" not in prompt
    assert "## Shared Findings" not in prompt
    assert "Required actions:" not in prompt
    assert "Null deref on empty config." in prompt
    assert "Crash is reachable from unauthenticated input." in prompt


def test_rework_prompt_survives_a_task_with_no_open_feedback(tmp_path) -> None:
    """`task.next` builds this prompt for every claim, not just a reopened one."""
    prompt = build_rework_prompt(state_path(tmp_path), reopened_task([]))

    assert "## Open Feedback" in prompt
    assert "None." in prompt
    assert "### Other Feedback" not in prompt


def test_comment_prompt_line_leads_with_comment_id(tmp_path) -> None:
    """The id leads every line: it is how a comment is referenced back."""
    line = comment_prompt_line(
        feedback_comment(
            "C7",
            "security-a",
            "Finding body.",
            created_at="2026-05-17T00:01:00Z",
        )
    )
    assert line.startswith("- [C7 | 2026-05-17T00:01:00Z | review_feedback | security-a")
