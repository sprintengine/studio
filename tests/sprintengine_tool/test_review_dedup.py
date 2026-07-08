"""Concurrent review finding dedup prompt tests.

Dedup is prompt-composition only: reviewers see other gates' open findings as
a known-findings list and confirm them by comment id instead of re-describing
them; the rework prompt groups feedback by gate and lists shared findings once
with every gate attributed. No verdict or lifecycle behavior changes.
"""

from __future__ import annotations

from pathlib import Path

from helpers import create_team, task
from sprintengine_core.tool.comments import comment_prompt_line, shared_finding_lines
from sprintengine_core.tool.phase_prompts import build_rework_prompt

CONFIRM_GUIDANCE = "confirm it by comment id in"


def feedback_comment(
    comment_id: str,
    gate_id: str,
    actor: str,
    body: str,
    *,
    created_at: str,
    actions: list[str] | None = None,
    comment_type: str = "review_feedback",
) -> dict:
    data: dict = {"status": "open", "gateId": gate_id, "verdict": "changes_requested"}
    if actions:
        data["requiredActions"] = actions
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


def reviewable_task(comments: list[dict]) -> dict:
    record = task("T1", "Implement reviewed feature", "developer", "review")
    record["evidence"] = {"summary": "Implemented.", "touchedFiles": [], "commandsRan": [], "results": []}
    record["comments"] = comments
    record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Code quality",
            "attempts": [],
        },
        {
            "id": "security",
            "phase": "review",
            "role": "security",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Security",
            "attempts": [],
        },
    ]
    return record


def test_gate_review_prompt_separates_known_findings_from_other_gates(tmp_path) -> None:
    record = reviewable_task([
        feedback_comment(
            "C1",
            "security",
            "security-fixture",
            "Token is logged in plaintext.",
            created_at="2026-05-17T00:01:00Z",
            actions=["Redact the token in sprintengine_core/tool/shell.py"],
        ),
        feedback_comment(
            "C2",
            "code-review",
            "code_reviewer-old",
            "Missing null check.",
            created_at="2026-05-17T00:02:00Z",
        ),
    ])
    fixture = create_team(tmp_path, "dedup-known-findings", [record])

    payload = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "reviewer-fixture")

    assert payload["ok"] is True
    assert payload["claimed"] is True
    prompt = payload["prompt"]
    known_index = prompt.index("## Known Findings From Other Gates (newest first)")
    own_index = prompt.index("## Open Feedback From This Gate (newest first)")
    assert known_index < prompt.index("Token is logged in plaintext.") < own_index
    assert own_index < prompt.index("Missing null check.")
    assert "[C1 | " in prompt
    assert "[C2 | " in prompt
    # The confirm-by-id guidance is delivered once, by the gate feedback skill
    # composed into this prompt — not duplicated inline by the prompt builder.
    assert prompt.count(CONFIRM_GUIDANCE) == 1


def rework_state_path(tmp_path) -> Path:
    return tmp_path / ".multi-code" / "sprintengine" / "dedup-team" / "state.json"


def test_rework_prompt_groups_feedback_by_gate_and_lists_shared_findings(tmp_path) -> None:
    record = reviewable_task([
        feedback_comment(
            "C1",
            "code-review",
            "code_reviewer-a",
            "Null deref on empty config.",
            created_at="2026-05-17T00:01:00Z",
            actions=["Fix the null check in sprintengine_core/tool/config.py"],
        ),
        feedback_comment(
            "C2",
            "security",
            "security-a",
            "Crash is reachable from unauthenticated input.",
            created_at="2026-05-17T00:02:00Z",
            actions=["Fix the null check in sprintengine_core/tool/config.py"],
        ),
    ])
    record["status"] = "changes_requested"

    prompt = build_rework_prompt(rework_state_path(tmp_path), record)

    assert "## Open Feedback (grouped by gate, newest first)" in prompt
    assert "### Gate `code-review`" in prompt
    assert "### Gate `security`" in prompt
    shared_index = prompt.index("## Shared Findings")
    shared_line = prompt[shared_index:].splitlines()[1]
    assert "Fix the null check in sprintengine_core/tool/config.py" in shared_line
    assert "security (C2)" in shared_line
    assert "code-review (C1)" in shared_line


def test_rework_prompt_confirms_reference_attributes_both_gates(tmp_path) -> None:
    record = reviewable_task([
        feedback_comment(
            "C1",
            "code-review",
            "code_reviewer-a",
            "Null deref on empty config.",
            created_at="2026-05-17T00:01:00Z",
            actions=["Fix the null check in sprintengine_core/tool/config.py"],
        ),
        feedback_comment(
            "C2",
            "security",
            "security-a",
            "Same defect, security impact.",
            created_at="2026-05-17T00:02:00Z",
            actions=["confirms C1 — reachable from unauthenticated input"],
        ),
    ])
    record["status"] = "changes_requested"

    prompt = build_rework_prompt(rework_state_path(tmp_path), record)

    shared_index = prompt.index("## Shared Findings")
    shared_line = prompt[shared_index:].splitlines()[1]
    assert "Fix the null check in sprintengine_core/tool/config.py" in shared_line
    assert "code-review (C1)" in shared_line
    assert "security (C2)" in shared_line


def test_rework_prompt_groups_ungated_feedback_under_other_feedback(tmp_path) -> None:
    record = reviewable_task([
        feedback_comment(
            "C1",
            "",
            "architect-fixture",
            "Scope question raised outside any gate.",
            created_at="2026-05-17T00:01:00Z",
            comment_type="architect_feedback",
        ),
    ])
    record["status"] = "changes_requested"

    prompt = build_rework_prompt(rework_state_path(tmp_path), record)

    other_index = prompt.index("### Other Feedback")
    assert other_index < prompt.index("Scope question raised outside any gate.")
    assert "### Gate ``" not in prompt


def test_rework_prompt_without_shared_findings_omits_section(tmp_path) -> None:
    record = reviewable_task([
        feedback_comment(
            "C1",
            "code-review",
            "code_reviewer-a",
            "Null deref on empty config.",
            created_at="2026-05-17T00:01:00Z",
            actions=["Fix the null check in sprintengine_core/tool/config.py"],
        ),
    ])
    record["status"] = "changes_requested"

    prompt = build_rework_prompt(rework_state_path(tmp_path), record)

    assert "## Shared Findings" not in prompt
    assert "### Gate `code-review`" in prompt


def test_shared_finding_lines_ignore_self_references_and_unknown_ids() -> None:
    comments = [
        feedback_comment(
            "C1",
            "code-review",
            "code_reviewer-a",
            "Self reference.",
            created_at="2026-05-17T00:01:00Z",
            actions=["confirms C1 — circular", "confirms C9 — dangling"],
        ),
    ]
    assert shared_finding_lines(comments) == []


def test_comment_prompt_line_leads_with_comment_id() -> None:
    line = comment_prompt_line(
        feedback_comment(
            "C7",
            "security",
            "security-a",
            "Finding body.",
            created_at="2026-05-17T00:01:00Z",
        )
    )
    assert line.startswith("- [C7 | 2026-05-17T00:01:00Z | review_feedback | security-a")
