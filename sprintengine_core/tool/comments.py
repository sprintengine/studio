"""Task comment filtering and prompt formatting helpers."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

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
