from __future__ import annotations

import errno
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

try:
    import fcntl as _fcntl_module
    _msvcrt_module = None
except ImportError:  # Windows
    _fcntl_module = None
    import msvcrt as _msvcrt_module  # type: ignore[import-not-found]

"""GitHub issue marker and lifecycle synchronization helpers."""

GITHUB_ISSUE_URL_RE = re.compile(r"^https://github\.com/([^/]+)/([^/]+)/issues/(\d+)(?:[/?#].*)?$")
GITHUB_EXTERNAL_KEY_RE = re.compile(r"^([^/\s]+)/([^#\s]+)#(\d+)$")
SWITCHBOARD_GITHUB_MARKER_RE = re.compile(r"<!--\s*multicode:switchboard\s+([^>]*)-->")


def parse_marker_attributes(raw: str) -> dict[str, str]:
    attributes: dict[str, str] = {}
    for match in re.finditer(r"([A-Za-z][A-Za-z0-9_-]*)=([^\s>]+)", raw):
        attributes[match.group(1)] = match.group(2).strip("\"'")
    return attributes


def switchboard_markers_from_body(body: str) -> list[dict[str, str]]:
    markers: list[dict[str, str]] = []
    for match in SWITCHBOARD_GITHUB_MARKER_RE.finditer(body):
        attributes = parse_marker_attributes(match.group(1))
        if attributes:
            markers.append(attributes)
    return markers


def github_issue_ref_for_task(task: dict[str, Any]) -> dict[str, Any] | None:
    source = task.get("source") if isinstance(task.get("source"), dict) else {}
    if source.get("type") != "github":
        return None
    external_key = source.get("externalKey")
    if isinstance(external_key, str):
        match = GITHUB_EXTERNAL_KEY_RE.match(external_key.strip())
        if match:
            return {"owner": match.group(1), "repo": match.group(2), "number": int(match.group(3))}
    external_url = source.get("externalUrl")
    if isinstance(external_url, str):
        match = GITHUB_ISSUE_URL_RE.match(external_url.strip())
        if match:
            return {"owner": match.group(1), "repo": match.group(2), "number": int(match.group(3))}
    return None


def github_issue_api_path(ref: dict[str, Any], suffix: str = "") -> str:
    return f"repos/{ref['owner']}/{ref['repo']}/issues/{ref['number']}{suffix}"


def github_issue_branch_for_task(task: dict[str, Any]) -> str | None:
    ref = github_issue_ref_for_task(task)
    if not ref:
        return None
    return github_issue_branch(int(ref["number"]))


def github_issue_related_line(task: dict[str, Any]) -> str | None:
    ref = github_issue_ref_for_task(task)
    if not ref:
        return None
    return f"Related to #{ref['number']}"


def read_github_issue_comments(workspace: Path, ref: dict[str, Any]) -> list[dict[str, Any]]:
    require_gh()
    completed = run_gh_checked(workspace, ["api", "--paginate", "--slurp", f"{github_issue_api_path(ref, '/comments')}?per_page=100"])
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SwitchboardError("GitHub issue comments returned invalid JSON.") from exc
    if not isinstance(payload, list):
        raise SwitchboardError("GitHub issue comments returned an unexpected response shape.")
    if payload and all(isinstance(page, list) for page in payload):
        return [item for page in payload for item in page if isinstance(item, dict)]
    return [item for item in payload if isinstance(item, dict)]


def marker_matches_comment(comment: dict[str, Any], *, task_id: str | None = None, event: str | None = None) -> dict[str, str] | None:
    body = comment.get("body")
    if not isinstance(body, str):
        return None
    for marker in switchboard_markers_from_body(body):
        if task_id is not None and marker.get("task") != task_id:
            continue
        if event is not None and marker.get("event") != event:
            continue
        return marker
    return None


def active_github_claim_for_issue(workspace: Path, ref: dict[str, Any], *, task_id: str) -> dict[str, Any] | None:
    for comment in read_github_issue_comments(workspace, ref):
        marker = marker_matches_comment(comment, event="claim")
        if not marker:
            continue
        state = marker.get("state", "active")
        if state not in {"active", "claimed", "in_progress"}:
            continue
        if marker.get("task") == task_id:
            continue
        return {"comment": comment, "marker": marker}
    return None


def has_active_github_claim_for_task(workspace: Path, ref: dict[str, Any], *, task_id: str) -> bool:
    for comment in read_github_issue_comments(workspace, ref):
        marker = marker_matches_comment(comment, task_id=task_id, event="claim")
        if not marker:
            continue
        if marker.get("state", "active") in {"active", "claimed", "in_progress"}:
            return True
    return False


def remote_branch_exists(workspace: Path, branch: str) -> bool:
    completed = run_git_checked(workspace, ["ls-remote", "--heads", "origin", branch], allow_failure=True)
    return completed.returncode == 0 and bool(completed.stdout.strip())


def push_github_coordination_branch(worktree: Path, branch: str) -> None:
    run_git_checked(worktree, ["push", "-u", "origin", branch])


def post_or_update_github_issue_comment(
    workspace: Path,
    task: dict[str, Any],
    *,
    event: str,
    body: str,
    marker_fields: dict[str, str],
) -> None:
    ref = github_issue_ref_for_task(task)
    if not ref:
        return
    require_gh()
    marker = " ".join([f"{key}={value}" for key, value in marker_fields.items()])
    full_body = f"{body.strip()}\n\n<!-- multicode:switchboard {marker} -->"
    existing_comment_id: str | None = None
    for comment in read_github_issue_comments(workspace, ref):
        if marker_matches_comment(comment, task_id=str(task.get("id")), event=event):
            comment_id = comment.get("id")
            if isinstance(comment_id, int):
                existing_comment_id = str(comment_id)
            elif isinstance(comment_id, str) and comment_id:
                existing_comment_id = comment_id
            break
    if existing_comment_id:
        run_gh_checked(workspace, ["api", f"repos/{ref['owner']}/{ref['repo']}/issues/comments/{existing_comment_id}", "-X", "PATCH", "-f", f"body={full_body}"])
    else:
        run_gh_checked(workspace, ["api", github_issue_api_path(ref, "/comments"), "-f", f"body={full_body}"])


def append_github_sync_failure_comment(task: dict[str, Any], message: str) -> dict[str, Any]:
    now = now_iso()
    return {
        **task,
        "updatedAt": now,
        "comments": [
            *task.get("comments", []),
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "system", "id": "switchboard-github", "name": "Switchboard GitHub Sync"},
                "kind": "comment",
                "body": f"GitHub sync failed after the local Switchboard update: {message}",
                "createdAt": now,
            },
        ],
    }


def try_github_sync(task: dict[str, Any], sync: Any) -> tuple[dict[str, Any], str | None]:
    try:
        sync()
        return task, None
    except SwitchboardError as exc:
        return append_github_sync_failure_comment(task, str(exc)), str(exc)


def prepare_github_remote_claim(workspace: Path, task: dict[str, Any], *, owner: str, branch: str) -> None:
    ref = github_issue_ref_for_task(task)
    if not ref:
        return
    conflict = active_github_claim_for_issue(workspace, ref, task_id=str(task["id"]))
    own_active_claim = has_active_github_claim_for_task(workspace, ref, task_id=str(task["id"]))
    if conflict:
        marker = conflict["marker"]
        claimed_by = marker.get("owner") or "another Switchboard user"
        claimed_branch = marker.get("branch")
        details = f" Branch: {claimed_branch}." if claimed_branch else ""
        raise SwitchboardError(f"GitHub issue already has an active Switchboard claim by {claimed_by}.{details}")
    if remote_branch_exists(workspace, branch) and not (own_active_claim or branch == github_issue_branch_for_task(task)):
        raise SwitchboardError(f"GitHub branch {branch} already exists for this issue.")
    post_or_update_github_issue_comment(
        workspace,
        task,
        event="claim",
        body=(
            f"Switchboard claimed this issue for {owner}.\n\n"
            f"Task: {task['id']}\n"
            f"Branch: `{branch}`"
        ),
        marker_fields={
            "event": "claim",
            "task": str(task["id"]),
            "state": "active",
            "owner": sanitized_branch_component(owner),
            "branch": branch,
        },
    )


def retire_github_remote_claim(workspace: Path, task: dict[str, Any], *, state: str, body: str) -> None:
    ref = github_issue_ref_for_task(task)
    if not ref:
        return
    branch = task.get("branchName") if isinstance(task.get("branchName"), str) and task.get("branchName").strip() else github_issue_branch_for_task(task)
    fields = {
        "event": "claim",
        "task": str(task["id"]),
        "state": state,
    }
    if branch:
        fields["branch"] = branch
    post_or_update_github_issue_comment(workspace, task, event="claim", body=body, marker_fields=fields)


def sync_github_lifecycle_comment(workspace: Path, task: dict[str, Any], *, event: str, body: str, state: str | None = None) -> None:
    ref = github_issue_ref_for_task(task)
    if not ref:
        return
    marker = {
        "event": event,
        "task": str(task["id"]),
    }
    if state:
        marker["state"] = state
    post_or_update_github_issue_comment(workspace, task, event=event, body=body, marker_fields=marker)


def create_or_reuse_pull_request(workspace: Path, task: dict[str, Any], evidence: dict[str, Any]) -> str | None:
    execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
    execution_id = execution.get("activeExecutionId")
    path_value = execution.get("worktreePath")
    if not isinstance(execution_id, str) or not isinstance(path_value, str):
        return None
    require_gh()
    worktree = validate_worktree_path(workspace, Path(path_value))
    run_gh_checked(worktree, ["auth", "status"])
    branch = current_git_branch(worktree, execution.get("worktreeBranch") if isinstance(execution.get("worktreeBranch"), str) else None)
    commit_worktree_changes_if_needed(worktree, task, execution_id)
    run_git_checked(worktree, ["push", "-u", "origin", branch])

    existing = run_gh_checked(worktree, ["pr", "view", branch, "--json", "url", "--jq", ".url"], allow_failure=True)
    existing_url = existing.stdout.strip()
    if existing.returncode == 0 and existing_url.startswith("http"):
        return existing_url

    base = default_pr_base_branch(workspace)
    title = compact_commit_subject(str(task.get("title") or task.get("identifier") or task.get("id") or "Switchboard task"))
    summary = evidence.get("summary") if isinstance(evidence.get("summary"), str) else ""
    body = "\n".join(
        [item for item in [
            github_issue_related_line(task),
            f"Switchboard task: {task.get('id')}",
            f"Execution: {execution_id}",
            "",
            summary,
        ] if item is not None]
    ).strip()
    created = run_gh_checked(worktree, ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body])
    pr_url = parse_url_from_output(created.stdout) or parse_url_from_output(created.stderr)
    if not pr_url:
        raise SwitchboardError("GitHub CLI did not return a pull request URL.")
    return pr_url
