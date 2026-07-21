"""Response shaping for Sprint Engine MCP tool results.

MCP responses carry deltas and references, not state echoes. The run store
stays the source of truth (the app UI and Inspector read it from disk), so
agent-facing responses return a slim task card once and minimal acks
thereafter. Shaping happens only at the MCP boundary: the human/debug CLI
keeps the full command output shapes.

Shapers build new dicts and never mutate the task/state objects that
command results reference — those objects belong to the persisted run state.
"""

from __future__ import annotations

from typing import Any

from sprintengine_core.tool.comments import (
    latest_implementation_comment,
    newest_comments,
    open_feedback_comments,
)

# Newest open review_feedback/user_note comments included in mutation acks so
# a working agent still notices feedback posted mid-task. Before slimming this
# signal travelled accidentally inside the full-task echo.
ACK_OPEN_FEEDBACK_LIMIT = 5

# Newest open feedback comments carried on the slim task card (matches the
# rework-prompt convention).
CARD_OPEN_FEEDBACK_LIMIT = 10

# Newest task notes included in default slim cards. Full notes are available
# through `task.get include=["notes"]`.
CARD_NOTES_LIMIT = 5

# Per-string cap for human-prose fields that can otherwise carry full
# architect rulings into every claim/read response.
CARD_TEXT_LIMIT = 700

# Comments returned by sprintengine.task.comment.list when the caller does not
# pass an explicit limit.
COMMENT_LIST_DEFAULT_LIMIT = 20

TASK_GET_INCLUDE_SECTIONS =("activity", "comments", "evidence_log", "diffs", "notes", "needs_input")

# Mutating tools whose responses become minimal acks: the agent already knows
# what it wrote, so the full task dict is replaced with task identity fields
# plus the open-feedback delta.
MUTATION_ACK_TOOLS = {
    "sprintengine.task.log",
    "sprintengine.task.publish",
    "sprintengine.task.note",
    "sprintengine.task.comment",
    "sprintengine.task.status",
    "sprintengine.task.resolve_input",
    "sprintengine.task.release",
    "sprintengine.task.advance",
    "sprintengine.task.request_changes",
    "sprintengine.task.approve_rework",
    "sprintengine.task.reassign_review",
    "sprintengine.plan.add_task",
    "sprintengine.plan.update_task",
    "sprintengine.plan.add_dependency",
    "sprintengine.plan.remove_dependency",
    "sprintengine.artifact.add",
    "sprintengine.artifact.ready",
    "sprintengine.artifact.approve",
    "sprintengine.artifact.request_changes",
}

# Read tools whose `task` payload becomes the slim card. The server-composed
# review/rework prompts riding beside the card are built from full store state
# and are not affected by card slimming.
SLIM_CARD_TOOLS = {
    "sprintengine.task.next",
    "sprintengine.task.claim",
}


def _comment_delta(comment: dict[str, Any]) -> dict[str, Any]:
    delta = {
        key: comment.get(key)
        for key in ("id", "type", "actor", "authorRole", "source", "body", "createdAt", "paths")
        if comment.get(key) is not None
    }
    # Card/ack surfaces carry the gist; the full body stays readable through
    # `task.comment.list` and the server-composed review/rework prompts.
    if isinstance(delta.get("body"), str):
        text, truncated = _truncate_text(delta["body"])
        delta["body"] = text
        if truncated:
            delta["bodyTruncated"] = True
    return delta


def _open_user_notes(task: dict[str, Any]) -> list[dict[str, Any]]:
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    return [
        comment for comment in comments
        if isinstance(comment, dict)
        and comment.get("type") == "user_note"
        and (not isinstance(comment.get("data"), dict) or comment["data"].get("status", "open") == "open")
    ]


def open_feedback_delta(task: Any, limit: int) -> list[dict[str, Any]]:
    """Open feedback ordered newest first, including user notes — the explicit
    replacement for the mid-task feedback signal that used to travel inside
    full-task echoes."""
    if not isinstance(task, dict):
        return []
    feedback = open_feedback_comments(task)
    seen_ids = {id(comment) for comment in feedback}
    feedback.extend(comment for comment in _open_user_notes(task) if id(comment) not in seen_ids)
    comments = newest_comments(feedback, limit=limit)
    return [_comment_delta(comment) for comment in comments]


def _truncate_text(value: str, limit: int = CARD_TEXT_LIMIT) -> tuple[str, bool]:
    compact = value.strip()
    if len(compact) <= limit:
        return compact, False
    return f"{compact[:limit - 3].rstrip()}...", True


def _slim_notes(notes: Any) -> tuple[list[str], bool]:
    if not isinstance(notes, list):
        return [], False
    selected = notes[-CARD_NOTES_LIMIT:]
    slim: list[str] = []
    truncated = len(notes) > CARD_NOTES_LIMIT
    for note in selected:
        text, was_truncated = _truncate_text(str(note))
        slim.append(text)
        truncated = truncated or was_truncated
    return slim, truncated


def _slim_needs_input(needs_input: Any) -> tuple[dict[str, Any] | None, bool]:
    if not isinstance(needs_input, dict):
        return None, False
    slim: dict[str, Any] = {}
    truncated = False
    for key, value in needs_input.items():
        if isinstance(value, str):
            text, was_truncated = _truncate_text(value)
            slim[key] = text
            truncated = truncated or was_truncated
        else:
            slim[key] = value
    return slim, truncated


def task_stub(task: Any) -> dict[str, Any] | None:
    if not isinstance(task, dict):
        return None
    return {
        "id": task.get("id"),
        "title": task.get("title"),
        "status": task.get("status"),
        "role": task.get("role"),
    }


def slim_task_card(task: Any) -> dict[str, Any] | None:
    if not isinstance(task, dict):
        return None
    evidence = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
    card: dict[str, Any] = {
        key: task.get(key)
        for key in (
            "id",
            "title",
            "role",
            "status",
            "description",
            "acceptanceCriteria",
            "implementationNotes",
            "ownedPaths",
            "dependsOn",
        )
        if task.get(key) is not None
    }
    notes, notes_truncated = _slim_notes(task.get("notes"))
    if notes:
        card["notes"] = notes
    if notes_truncated:
        card["notesTruncated"] = True
    needs_input, needs_input_truncated = _slim_needs_input(task.get("needsInput"))
    if needs_input:
        card["needsInput"] = needs_input
    if needs_input_truncated:
        card["needsInputTruncated"] = True
    summary_text, summary_truncated = _truncate_text(str(evidence.get("summary") or ""))
    card["evidence"] = {
        "summary": summary_text,
        "touchedFiles": list(evidence.get("touchedFiles") or []),
    }
    if summary_truncated:
        card["evidence"]["summaryTruncated"] = True
    open_feedback = open_feedback_delta(task, CARD_OPEN_FEEDBACK_LIMIT)
    if open_feedback:
        card["openFeedback"] = open_feedback
    implementation = latest_implementation_comment(task)
    if implementation is not None:
        card["latestImplementationComment"] = _comment_delta(implementation)
    phases = task.get("phases")
    if isinstance(phases, list):
        card["phases"] = list(phases)
    return card


def expanded_task_card(task: Any, include: list[str]) -> dict[str, Any] | None:
    """Slim card plus the deep-read sections requested via `include`."""
    card = slim_task_card(task)
    if card is None or not isinstance(task, dict):
        return card
    requested = {section for section in include if section in TASK_GET_INCLUDE_SECTIONS}
    evidence = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
    if "activity" in requested:
        card["activity"] = list(task.get("activity") or [])
    if "comments" in requested:
        card["comments"] = list(task.get("comments") or [])
    if "notes" in requested:
        card["notes"] = list(task.get("notes") or [])
        card.pop("notesTruncated", None)
    if "needs_input" in requested:
        needs_input = task.get("needsInput")
        if isinstance(needs_input, dict):
            card["needsInput"] = dict(needs_input)
        card.pop("needsInputTruncated", None)
    if "evidence_log" in requested:
        card["evidence"]["summary"] = str(evidence.get("summary") or "")
        card["evidence"].pop("summaryTruncated", None)
        card["evidence"]["commandsRan"] = list(evidence.get("commandsRan") or [])
        card["evidence"]["results"] = list(evidence.get("results") or [])
        card["evidence"]["scopeExpansions"] = list(evidence.get("scopeExpansions") or [])
    if "diffs" in requested:
        card["evidence"]["diffs"] = list(evidence.get("diffs") or [])
    return card


# Prose payload fields whose card surfaces cap at CARD_TEXT_LIMIT. Acks flag
# over-limit writes so the author learns the overflow is truncated for
# downstream agents — advisory only, the evidence itself is never rejected.
# task.comment is deliberately absent: its ack already carries the signal as
# `comment.bodyTruncated` from the same `_truncate_text` predicate.
ACK_CARD_PROSE_FIELDS: dict[str, str] = {
    "sprintengine.task.log": "summary",
}


def _mutation_ack(result: dict[str, Any], payload: dict[str, Any], tool_name: str) -> dict[str, Any]:
    shaped = dict(result)
    task = shaped.pop("task", None)
    if isinstance(task, dict):
        shaped.setdefault("taskId", task.get("id"))
        shaped.setdefault("taskStatus", task.get("status"))
        feedback = open_feedback_delta(task, ACK_OPEN_FEEDBACK_LIMIT)
        if feedback:
            shaped["openFeedback"] = feedback
    comment = shaped.get("comment")
    if isinstance(comment, dict):
        # The author already knows what it wrote; the ack carries the delta
        # form other surfaces will show, not a full echo. Structured `data`
        # (open/closed status, finding payloads) is machine-first and stays.
        delta = _comment_delta(comment)
        if isinstance(comment.get("data"), dict):
            delta["data"] = comment["data"]
        shaped["comment"] = delta
    prose_field = ACK_CARD_PROSE_FIELDS.get(tool_name)
    if prose_field:
        prose = payload.get(prose_field)
        if isinstance(prose, str):
            _, over_limit = _truncate_text(prose)
            if over_limit:
                shaped["exceedsCardLimit"] = True
    return shaped


def _slim_card_response(result: dict[str, Any]) -> dict[str, Any]:
    shaped = dict(result)
    if isinstance(shaped.get("task"), dict):
        shaped["task"] = slim_task_card(shaped["task"])
    return shaped


def _directive_response(result: dict[str, Any]) -> dict[str, Any]:
    shaped = dict(result)
    if isinstance(shaped.get("task"), dict):
        shaped["task"] = task_stub(shaped["task"])
    if shaped.get("releasedExpired") == []:
        del shaped["releasedExpired"]
    return shaped


def _heartbeat_response(result: dict[str, Any]) -> dict[str, Any]:
    """Heartbeat is pure liveness: the mutation only renews the lease `heartbeatAt`
    of the tasks the worker owns (MC-1591 deleted the agents-map mirror), so a
    heartbeat can never observe a reassignment — assignment state travels through
    the `task.next` claim/resume, never through this ack. `known` reports whether
    the worker held any active lease to renew."""
    return {"ok": True, "known": result.get("known") is not False}


def _summary_response(result: dict[str, Any]) -> dict[str, Any]:
    shaped = dict(result)
    summary = shaped.get("summary")
    if not isinstance(summary, dict):
        return shaped
    slim = dict(summary)
    for key in ("touchedFiles", "commandsRan", "results"):
        value = slim.pop(key, None)
        slim[f"{key}Count"] = len(value) if isinstance(value, list) else 0
    slim["evidenceDetail"] = "Use sprintengine.task.get with include=[\"evidence_log\"] for a task's full commands and results."
    shaped["summary"] = slim
    return shaped


def _comment_list_response(result: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    shaped = dict(result)
    comments = shaped.get("comments")
    if not isinstance(comments, list):
        return shaped
    raw_limit = payload.get("limit")
    limit = raw_limit if isinstance(raw_limit, int) and raw_limit > 0 else COMMENT_LIST_DEFAULT_LIMIT
    shaped["totalCount"] = len(comments)
    if len(comments) > limit:
        shaped["comments"] = comments[-limit:]
        shaped["truncated"] = True
    else:
        shaped["truncated"] = False
    return shaped


def shape_tool_result(tool_name: str, payload: dict[str, Any], result: Any) -> Any:
    """Shape a successful tool result at the MCP boundary.

    Error results (`ok` is not True) keep their original shape — they are
    already small and their `task` fields are identity stubs.
    """
    if not isinstance(result, dict) or result.get("ok") is not True:
        return result
    if tool_name in MUTATION_ACK_TOOLS:
        return _mutation_ack(result, payload, tool_name)
    if tool_name in SLIM_CARD_TOOLS:
        return _slim_card_response(result)
    if tool_name == "sprintengine.task.get":
        shaped = dict(result)
        include = payload.get("include") if isinstance(payload.get("include"), list) else []
        shaped["task"] = expanded_task_card(shaped.get("task"), [str(item) for item in include])
        return shaped
    if tool_name == "sprintengine.agent.next_directive":
        return _directive_response(result)
    if tool_name == "sprintengine.agent.heartbeat":
        return _heartbeat_response(result)
    if tool_name == "sprintengine.summary":
        return _summary_response(result)
    if tool_name == "sprintengine.task.comment.list":
        return _comment_list_response(result, payload)
    return result
