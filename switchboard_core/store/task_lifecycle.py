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

"""Task publish, requeue, and request-changes flows."""

def publish_task(
    workspace: Path,
    task_id: str,
    *,
    to_status: str,
    summary: str | None = None,
    artifacts: list[str] | None = None,
    commands_run: list[str] | None = None,
    touched_files: list[str] | None = None,
    comment: str | None = None,
) -> LocatedTask:
    if to_status not in PUBLISH_TARGETS:
        raise SwitchboardError("--to must be one of testing, review, or done.")
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    if located.folder_status == "inbox":
        raise SwitchboardError("Inbox tasks cannot be published.")
    with locked_folders(workspace, [located.folder_status, to_status], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        next_evidence = merged_evidence(
            located.task,
            summary=summary,
            artifacts=artifacts,
            commands_run=commands_run,
            touched_files=touched_files,
        )
        validate_publish(located.task, located.folder_status, to_status, next_evidence)
        destination = task_path(workspace, to_status, task_id)
        if destination.exists() and destination != located.path:
            raise SwitchboardError("A Switchboard task already exists in the destination folder.")
        pull_request_url = None
        if located.folder_status == "in_progress" and to_status == "testing":
            pull_request_url = create_or_reuse_pull_request(workspace, located.task, next_evidence)
            if pull_request_url:
                artifacts_with_pr = list(next_evidence.get("artifacts", []))
                if pull_request_url not in artifacts_with_pr:
                    artifacts_with_pr.append(pull_request_url)
                next_evidence = {**next_evidence, "artifacts": artifacts_with_pr}
        now = now_iso()
        comments = list(located.task["comments"])
        if comment and comment.strip():
            comments.append(
                {
                    "id": str(uuid.uuid4()),
                    "author": {"type": "system", "id": "switchboard-cli", "name": "Switchboard CLI"},
                    "kind": "evidence",
                    "body": comment.strip(),
                    "createdAt": now,
                }
            )
        comments.append(
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                "kind": "status_change",
                "body": f"Published from {located.folder_status} to {to_status}."
                + (f" Pull request: {pull_request_url}" if pull_request_url else ""),
                "createdAt": now,
            }
        )
        task = {
            **located.task,
            "state": to_status,
            "claim": None,
            "execution": clear_active_execution_metadata(located.task),
            "evidence": next_evidence,
            "updatedAt": now,
            "comments": comments,
        }
        atomic_write_json(located.path, task)
        os.replace(located.path, destination)
        published = read_task_file(destination, to_status)
        if github_issue_ref_for_task(published.task):
            publish_body = (
                f"Switchboard published this task from {located.folder_status} to {to_status}.\n\n"
                + (f"Pull request: {pull_request_url}\n" if pull_request_url else "")
                + f"Task: {task_id}"
            )
            def sync_publish() -> None:
                if located.folder_status == "in_progress" and to_status != "in_progress":
                    retire_github_remote_claim(workspace, published.task, state=to_status, body=publish_body)
                sync_github_lifecycle_comment(
                    workspace,
                    published.task,
                    event=f"published-{to_status}",
                    state=to_status,
                    body=publish_body,
                )

            next_task, failure = try_github_sync(published.task, sync_publish)
            if failure:
                atomic_write_json(destination, next_task)
                published = read_task_file(destination, to_status)
        return published


def requeue_task(workspace: Path, task_id: str, *, reason: str | None = None) -> LocatedTask:
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    target = REQUEUE_TRANSITIONS.get(located.folder_status)
    if not target:
        raise SwitchboardError(f"Cannot requeue a task from {located.folder_status}.")
    with locked_folders(workspace, [located.folder_status, target], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        target = REQUEUE_TRANSITIONS.get(located.folder_status)
        if not target:
            raise SwitchboardError(f"Cannot requeue a task from {located.folder_status}.")
        now = now_iso()
        comments = list(located.task["comments"])
        comments.append(
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                "kind": "status_change",
                "body": f"Requeued from {located.folder_status} to {target}."
                + (f" Reason: {reason.strip()}" if reason and reason.strip() else ""),
                "createdAt": now,
            }
        )
        task = {
            **located.task,
            "state": target,
            "claim": None,
            "execution": clear_active_execution_metadata(located.task),
            "updatedAt": now,
            "comments": comments,
        }
        destination = task_path(workspace, target, task_id)
        if destination.exists() and destination != located.path:
            raise SwitchboardError("A Switchboard task already exists in the destination folder.")
        atomic_write_json(located.path, task)
        os.replace(located.path, destination)
        requeued = read_task_file(destination, target)
        if github_issue_ref_for_task(requeued.task):
            requeue_body = (
                f"Switchboard requeued this task from {located.folder_status} to {target}."
                + (f"\n\nReason: {reason.strip()}" if reason and reason.strip() else "")
            )
            def sync_requeue() -> None:
                if located.folder_status == "in_progress":
                    retire_github_remote_claim(workspace, requeued.task, state="requeued", body=requeue_body)
                sync_github_lifecycle_comment(
                    workspace,
                    requeued.task,
                    event="requeued",
                    state=target,
                    body=requeue_body,
                )

            next_task, failure = try_github_sync(requeued.task, sync_requeue)
            if failure:
                atomic_write_json(destination, next_task)
                requeued = read_task_file(destination, target)
        return requeued


def request_changes_task(workspace: Path, task_id: str, *, reason: str) -> LocatedTask:
    if not isinstance(reason, str) or not reason.strip():
        raise SwitchboardError("--reason is required when requesting changes.")
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    target = REQUEST_CHANGES_TRANSITIONS.get(located.folder_status)
    if not target:
        raise SwitchboardError(f"Cannot request changes from {located.folder_status}.")
    with locked_folders(workspace, [located.folder_status, target], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        target = REQUEST_CHANGES_TRANSITIONS.get(located.folder_status)
        if not target:
            raise SwitchboardError(f"Cannot request changes from {located.folder_status}.")
        now = now_iso()
        claim = located.task.get("claim") if isinstance(located.task.get("claim"), dict) else {}
        owner = claim.get("owner") if isinstance(claim.get("owner"), str) and claim.get("owner").strip() else "switchboard-review"
        comments = [
            *located.task["comments"],
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "agent", "id": owner, "name": owner},
                "kind": "comment",
                "body": reason.strip(),
                "createdAt": now,
            },
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                "kind": "status_change",
                "body": f"Changes requested from {located.folder_status}; moved back to {target}.",
                "createdAt": now,
            },
        ]
        task = {
            **located.task,
            "state": target,
            "claim": None,
            "execution": clear_active_execution_metadata(located.task),
            "updatedAt": now,
            "comments": comments,
        }
        destination = task_path(workspace, target, task_id)
        if destination.exists() and destination != located.path:
            raise SwitchboardError("A Switchboard task already exists in the destination folder.")
        atomic_write_json(located.path, task)
        os.replace(located.path, destination)
        requested = read_task_file(destination, target)
        if github_issue_ref_for_task(requested.task):
            request_body = f"Switchboard requested changes and moved this task back to {target}.\n\n{reason.strip()}"
            def sync_request_changes() -> None:
                if located.folder_status == "in_progress":
                    retire_github_remote_claim(workspace, requested.task, state="changes_requested", body=request_body)
                sync_github_lifecycle_comment(
                    workspace,
                    requested.task,
                    event="changes-requested",
                    state=target,
                    body=request_body,
                )

            next_task, failure = try_github_sync(requested.task, sync_request_changes)
            if failure:
                atomic_write_json(destination, next_task)
                requested = read_task_file(destination, target)
        return requested

