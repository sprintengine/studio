"""Task comment filtering and prompt formatting helpers."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

FEEDBACK_REFERENCE_PATTERN = re.compile(r"\bconfirms\s+(C\d+)\b", re.IGNORECASE)

def open_feedback_comments(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    feedback_types = {"review_feedback", "test_feedback", "product_feedback", "architect_feedback"}
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    return [
        comment for comment in comments
        if isinstance(comment, dict)
        and comment.get("type") in feedback_types
        and (not isinstance(comment.get("data"), dict) or comment["data"].get("status", "open") == "open")
    ]

def open_rework_comments(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    rework_types = {"review_feedback", "test_feedback", "product_feedback", "architect_feedback", "needs_input"}
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    return [
        comment for comment in comments
        if isinstance(comment, dict)
        and comment.get("type") in rework_types
        and (not isinstance(comment.get("data"), dict) or comment["data"].get("status", "open") == "open")
    ]

def task_comments(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    return [comment for comment in comments if isinstance(comment, dict)]

def newest_comments(comments: List[Dict[str, Any]], limit: int = 5) -> List[Dict[str, Any]]:
    return sorted(comments, key=lambda comment: str(comment.get("createdAt") or ""), reverse=True)[:limit]

def comment_prompt_line(comment: Dict[str, Any]) -> str:
    data = comment.get("data") if isinstance(comment.get("data"), dict) else {}
    bits = []
    if comment.get("id"):
        bits.append(str(comment.get("id")))
    bits.extend([
        str(comment.get("createdAt") or "unknown-time"),
        str(comment.get("type") or "comment"),
        str(comment.get("actor") or "unknown-actor"),
    ])
    if data.get("gateId"):
        bits.append(f"gate={data.get('gateId')}")
    if data.get("verdict"):
        bits.append(f"verdict={data.get('verdict')}")
    if data.get("status"):
        bits.append(f"status={data.get('status')}")
    actions = comment_required_actions(comment)
    suffix = f" Required actions: {'; '.join(actions)}" if actions else ""
    return f"- [{' | '.join(bits)}] {str(comment.get('body') or '').strip()}{suffix}"

def feedback_gate_id(comment: Dict[str, Any]) -> str:
    data = comment.get("data") if isinstance(comment.get("data"), dict) else {}
    return str(data.get("gateId") or "").strip()


def comment_required_actions(comment: Dict[str, Any]) -> List[str]:
    data = comment.get("data") if isinstance(comment.get("data"), dict) else {}
    actions = data.get("requiredActions") if isinstance(data.get("requiredActions"), list) else []
    return [str(action).strip() for action in actions if str(action).strip()]


def feedback_source_label(comment: Dict[str, Any]) -> str:
    label = feedback_gate_id(comment) or str(comment.get("authorRole") or comment.get("actor") or "unknown")
    comment_id = str(comment.get("id") or "").strip()
    return f"{label} ({comment_id})" if comment_id else label


def grouped_feedback_lines(comments: List[Dict[str, Any]]) -> List[str]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for comment in comments:
        groups.setdefault(feedback_gate_id(comment), []).append(comment)
    lines: List[str] = []
    for key, group in groups.items():
        lines.append(f"### Gate `{key}`" if key else "### Other Feedback")
        lines.extend(comment_prompt_line(comment) for comment in group)
    return lines


def shared_finding_lines(comments: List[Dict[str, Any]]) -> List[str]:
    """Required actions filed by more than one gate, listed once with every
    gate attributed. Matches identical normalized action text plus explicit
    `confirms C<n>` references to another open feedback comment."""
    by_id = {str(comment.get("id")): comment for comment in comments if comment.get("id")}
    entries: Dict[str, Dict[str, Any]] = {}

    def record(action: str, source: str) -> None:
        key = " ".join(action.split()).casefold()
        entry = entries.setdefault(key, {"action": action, "sources": []})
        if source not in entry["sources"]:
            entry["sources"].append(source)

    for comment in comments:
        source = feedback_source_label(comment)
        for action in comment_required_actions(comment):
            reference = FEEDBACK_REFERENCE_PATTERN.search(action)
            referenced = by_id.get(reference.group(1)) if reference else None
            if referenced is not None and referenced is not comment:
                for referenced_action in comment_required_actions(referenced):
                    record(referenced_action, feedback_source_label(referenced))
                    record(referenced_action, source)
            else:
                record(action, source)
    return [
        f"- {entry['action']} — gates: {', '.join(entry['sources'])}"
        for entry in entries.values()
        if len(entry["sources"]) > 1
    ]


def diff_prompt_lines(evidence: Dict[str, Any]) -> List[str]:
    diffs = evidence.get("diffs") if isinstance(evidence.get("diffs"), list) else []
    lines: List[str] = []
    for diff in diffs:
        if not isinstance(diff, dict):
            continue
        path = str(diff.get("path") or "").strip()
        if not path:
            continue
        status = str(diff.get("status") or "unknown")
        additions = diff.get("additions") if isinstance(diff.get("additions"), int) else 0
        deletions = diff.get("deletions") if isinstance(diff.get("deletions"), int) else 0
        flags = []
        if diff.get("skippedReason"):
            flags.append(f"skipped={diff.get('skippedReason')}")
        if diff.get("truncated"):
            flags.append("truncated")
        if diff.get("binary"):
            flags.append("binary")
        suffix = f" ({', '.join(flags)})" if flags else ""
        lines.append(f"- `{path}` status=`{status}` +{additions} -{deletions}{suffix}")
    return lines

def latest_implementation_comment(task: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for comment in newest_comments(task_comments(task), limit=100):
        if comment.get("type") in {"implementation_summary", "implementation_response"}:
            return comment
    return None
