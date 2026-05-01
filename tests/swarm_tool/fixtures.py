from __future__ import annotations

from typing import Any

from helpers import (
    SwarmCli,
    assert_board_column,
    assert_event_type,
    assert_ready_tasks,
    assert_task_status,
    create_team,
    get_task,
    read_state,
    task,
)


def assert_prompt_includes(prompt: str, snippets: list[str]) -> None:
    missing = [snippet for snippet in snippets if snippet not in prompt]
    assert missing == []


def task_ids_by_status(state: dict[str, Any], status: str) -> list[str]:
    return [record["id"] for record in state["tasks"] if record["status"] == status]


def artifact_by_kind(state: dict[str, Any], kind: str) -> dict[str, Any]:
    matches = [artifact for artifact in state["artifacts"] if artifact.get("kind") == kind]
    assert len(matches) == 1
    return matches[0]
