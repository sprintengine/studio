from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .store import (
    CLAIMABLE_STATUSES,
    FOLDER_STATUSES,
    COMMENT_KINDS,
    AUTHOR_TYPES,
    PUBLISH_TARGETS,
    SOURCE_TYPES,
    TASK_STATUSES,
    SwitchboardError,
    add_comment,
    cancel_task,
    claim_task,
    create_task,
    find_task,
    init_workspace,
    import_inbox_task,
    move_task,
    promote_task,
    publish_task,
    read_all,
    record_for_output,
    recover_lock,
    requeue_task,
    runner_pause,
    runner_resume,
    runner_run,
    runner_start,
    runner_status,
    runner_stop,
    runner_tick,
    execution_logs,
    execution_stop,
    execution_status,
    execution_worktree_cleanup,
    task_summary,
    update_task,
    switchboard_root,
)
from .watchtower import (
    create_watchtower_run,
    create_watchtower_run_with_status,
    list_watchtower_runs_with_problems,
    read_watchtower_run,
    WATCHTOWER_RUN_STATUSES,
    update_watchtower_agent_status,
)
from .watchtower_runner import start_watchtower_review, start_watchtower_triage


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2))


def workspace_path(args: argparse.Namespace) -> Path:
    return Path(args.workspace)


def runner_server_descriptor_path(workspace: Path) -> Path:
    return switchboard_root(workspace) / "runner" / "server.json"


def read_runner_server_descriptor(workspace: Path) -> dict[str, Any] | None:
    try:
        parsed = json.loads(runner_server_descriptor_path(workspace).read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def post_runner_stop_to_backend(workspace: Path) -> dict[str, Any] | None:
    descriptor = read_runner_server_descriptor(workspace)
    if not descriptor:
        return None
    host = descriptor.get("host")
    port = descriptor.get("port")
    token = descriptor.get("token")
    if not isinstance(host, str) or not isinstance(port, int) or not isinstance(token, str):
        return None
    request = urllib.request.Request(
        f"http://{host}:{port}/runner/stop",
        data=b"{}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        terminate_descriptor_process(workspace, descriptor)
        return None
    return payload if isinstance(payload, dict) else None


def terminate_descriptor_process(workspace: Path, descriptor: dict[str, Any]) -> None:
    pid = descriptor.get("pid")
    if isinstance(pid, int) and pid > 0:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        runner_server_descriptor_path(workspace).unlink(missing_ok=True)
    except OSError:
        pass


def mutation_payload(
    *,
    action: str,
    previous: str | None,
    record: dict[str, Any],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    task = record["task"]
    location = record["location"]
    payload: dict[str, Any] = {
        "ok": True,
        "action": action,
        "id": task["id"],
        "previousFolder": previous,
        "nextFolder": location["folderStatus"],
        "summary": task_summary(task, location["folderStatus"]),
        "record": record,
    }
    if extra:
        payload.update(extra)
    return payload


def cmd_init(args: argparse.Namespace) -> int:
    emit(init_workspace(workspace_path(args)))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    tasks, problems, locks = read_all(workspace_path(args))
    status = args.status
    if status:
        tasks = [task for task in tasks if task.folder_status == status]
    emit(
        {
            "ok": True,
            "status": status,
            "tasks": [
                {
                    **task_summary(located.task, located.folder_status),
                    "folderStatus": located.folder_status,
                    "path": str(located.path),
                    "warnings": located.warnings,
                }
                for located in tasks
            ],
            "problems": problems,
            "locks": locks,
        }
    )
    return 0


def read_all_payload(workspace: Path) -> dict[str, Any]:
    tasks, problems, locks = read_all(workspace)
    root = switchboard_root(workspace)
    return {
        "ok": True,
        "workspaceRoot": str(workspace.expanduser().resolve()),
        "switchboardRoot": str(root),
        "tasks": [record_for_output(task) for task in tasks],
        "problems": problems,
        "locks": locks,
    }


def cmd_read_all(args: argparse.Namespace) -> int:
    emit(read_all_payload(workspace_path(args)))
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    located = find_task(workspace_path(args), args.task_id)
    emit({"ok": True, "record": record_for_output(located)})
    return 0


def cmd_create(args: argparse.Namespace) -> int:
    input_payload: dict[str, Any] = {}
    if args.input_json:
        parsed = json.loads(args.input_json)
        if not isinstance(parsed, dict):
            raise SwitchboardError("--input-json must contain a JSON object.")
        input_payload = parsed
    title = input_payload.get("title", args.title)
    if not isinstance(title, str):
        raise SwitchboardError("title is required.")
    source = input_payload.get("source")
    if source is None and any((args.source_type, args.source_external_id, args.source_external_key, args.source_external_url)):
        source = {
            "type": args.source_type,
            "externalId": args.source_external_id,
            "externalKey": args.source_external_key,
            "externalUrl": args.source_external_url,
        }
    located = create_task(
        workspace_path(args),
        title=title,
        description=input_payload.get("description", args.description or ""),
        inbox=bool(input_payload.get("origin") == "watchtower" or args.inbox),
        identifier=input_payload.get("identifier"),
        priority=input_payload.get("priority", args.priority),
        labels=input_payload.get("labels", args.label),
        source=source,
        comments=input_payload.get("comments"),
    )
    emit(mutation_payload(action="create", previous=None, record=record_for_output(located)))
    return 0


def cmd_import_task(args: argparse.Namespace) -> int:
    parsed = json.loads(args.input_json)
    if not isinstance(parsed, dict):
        raise SwitchboardError("--input-json must contain a JSON object.")
    located, status = import_inbox_task(
        workspace_path(args),
        provider=str(parsed.get("provider") or ""),
        external_id=parsed.get("externalId") if isinstance(parsed.get("externalId"), str) else None,
        external_key=parsed.get("externalKey") if isinstance(parsed.get("externalKey"), str) else None,
        external_url=parsed.get("externalUrl") if isinstance(parsed.get("externalUrl"), str) else None,
        identifier=parsed.get("identifier") if isinstance(parsed.get("identifier"), str) else None,
        title=parsed.get("title") if isinstance(parsed.get("title"), str) else "",
        description=parsed.get("description") if isinstance(parsed.get("description"), str) else "",
        labels=parsed.get("labels") if isinstance(parsed.get("labels"), list) else None,
        priority=parsed.get("priority"),
        updated_at=parsed.get("updatedAt") if isinstance(parsed.get("updatedAt"), str) else None,
    )
    if located is None:
        emit({"ok": True, "status": status, "created": False, "skipped": True})
        return 0
    emit(
        {
            **mutation_payload(action="import", previous=None, record=record_for_output(located)),
            "status": status,
            "created": True,
            "skipped": False,
        }
    )
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    parsed = json.loads(args.updates_json)
    if not isinstance(parsed, dict):
        raise SwitchboardError("--updates-json must contain a JSON object.")
    before = find_task(workspace_path(args), args.task_id)
    located = update_task(workspace_path(args), args.task_id, parsed)
    emit(mutation_payload(action="update", previous=before.folder_status, record=record_for_output(located)))
    return 0


def cmd_comment(args: argparse.Namespace) -> int:
    before = find_task(workspace_path(args), args.task_id)
    located = add_comment(
        workspace_path(args),
        args.task_id,
        body=args.body,
        author_name=args.author or "User",
        kind=args.kind,
        author_type=args.author_type,
        author_id=args.author_id,
    )
    emit(mutation_payload(action="comment", previous=before.folder_status, record=record_for_output(located)))
    return 0


def cmd_move(args: argparse.Namespace) -> int:
    before = find_task(workspace_path(args), args.task_id)
    located = move_task(workspace_path(args), args.task_id, args.to)
    emit(mutation_payload(action="move", previous=before.folder_status, record=record_for_output(located)))
    return 0


def cmd_promote(args: argparse.Namespace) -> int:
    before = find_task(workspace_path(args), args.task_id)
    located = promote_task(workspace_path(args), args.task_id)
    emit(mutation_payload(action="promote", previous=before.folder_status, record=record_for_output(located)))
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    before = find_task(workspace_path(args), args.task_id)
    located = cancel_task(workspace_path(args), args.task_id, reason=args.reason)
    emit(mutation_payload(action="cancel", previous=before.folder_status, record=record_for_output(located)))
    return 0


def cmd_claim(args: argparse.Namespace) -> int:
    located = claim_task(workspace_path(args), from_status=args.from_status, agent=args.agent)
    if located is None:
        emit({"ok": True, "action": "claim", "claimed": False, "from": args.from_status, "message": "No eligible task."})
        return 0
    previous = {
        "in_progress": "ready",
        "testing_in_progress": "testing",
        "review_in_progress": "review",
    }[located.folder_status]
    emit(
        mutation_payload(
            action="claim",
            previous=previous,
            record=record_for_output(located),
            extra={"claimed": True},
        )
    )
    return 0


def cmd_publish(args: argparse.Namespace) -> int:
    before = find_task(workspace_path(args), args.task_id)
    located = publish_task(
        workspace_path(args),
        args.task_id,
        to_status=args.to,
        summary=args.summary,
        artifacts=args.artifact,
        commands_run=args.command,
        touched_files=args.touched_file,
        comment=args.comment,
    )
    emit(mutation_payload(action="publish", previous=before.folder_status, record=record_for_output(located)))
    return 0


def cmd_recover_lock(args: argparse.Namespace) -> int:
    emit(recover_lock(workspace_path(args), args.status))
    return 0


def cmd_requeue(args: argparse.Namespace) -> int:
    before = find_task(workspace_path(args), args.task_id)
    located = requeue_task(workspace_path(args), args.task_id, reason=args.reason)
    emit(mutation_payload(action="requeue", previous=before.folder_status, record=record_for_output(located)))
    return 0


def cmd_runner_start(args: argparse.Namespace) -> int:
    emit(
        runner_start(
            workspace_path(args),
            provider=args.provider,
            cli=args.cli,
            queues=args.queue,
            max_concurrency=args.max_concurrency,
        )
    )
    return 0


def cmd_runner_pause(args: argparse.Namespace) -> int:
    emit(runner_pause(workspace_path(args)))
    return 0


def cmd_runner_resume(args: argparse.Namespace) -> int:
    emit(runner_resume(workspace_path(args)))
    return 0


def cmd_runner_stop(args: argparse.Namespace) -> int:
    workspace = workspace_path(args)
    emit(post_runner_stop_to_backend(workspace) or runner_stop(workspace))
    return 0


def cmd_runner_status(args: argparse.Namespace) -> int:
    emit(runner_status(workspace_path(args)))
    return 0


def cmd_runner_tick(args: argparse.Namespace) -> int:
    emit(runner_tick(workspace_path(args)))
    return 0


def cmd_runner_run(args: argparse.Namespace) -> int:
    emit(runner_run(workspace_path(args), once=args.once))
    return 0


def cmd_execution_status(args: argparse.Namespace) -> int:
    emit(execution_status(workspace_path(args), args.execution_id))
    return 0


def cmd_execution_logs(args: argparse.Namespace) -> int:
    emit(execution_logs(workspace_path(args), args.execution_id, stream=args.stream, tail=args.tail))
    return 0


def cmd_execution_stop(args: argparse.Namespace) -> int:
    emit(execution_stop(workspace_path(args), args.execution_id, reason=args.reason))
    return 0


def cmd_execution_worktree_cleanup(args: argparse.Namespace) -> int:
    emit(execution_worktree_cleanup(workspace_path(args), args.execution_id, force=args.force))
    return 0


def cmd_watchtower_run_create(args: argparse.Namespace) -> int:
    agents: list[dict[str, Any]] | None = None
    if args.agents_json:
        parsed = json.loads(args.agents_json)
        if not isinstance(parsed, list):
            raise SwitchboardError("--agents-json must contain a JSON array.")
        agents = [item for item in parsed if isinstance(item, dict)]
    run = (
        create_watchtower_run_with_status(workspace_path(args), preset=args.preset, agents=agents, status=args.status)
        if args.status != "pending" or agents is not None
        else create_watchtower_run(workspace_path(args), preset=args.preset)
    )
    emit({"ok": True, "run": run})
    return 0


def cmd_watchtower_run_status(args: argparse.Namespace) -> int:
    emit({"ok": True, "run": read_watchtower_run(workspace_path(args), args.run_id)})
    return 0


def cmd_watchtower_run_list(args: argparse.Namespace) -> int:
    runs, problems = list_watchtower_runs_with_problems(workspace_path(args))
    emit({"ok": True, "runs": runs, "problems": problems})
    return 0


def cmd_watchtower_run_agent_status(args: argparse.Namespace) -> int:
    emit({"ok": True, "run": update_watchtower_agent_status(workspace_path(args), args.run_id, args.agent_id, args.status)})
    return 0


def cmd_watchtower_start_review(args: argparse.Namespace) -> int:
    emit(start_watchtower_review(workspace_path(args), preset=args.preset))
    return 0


def cmd_watchtower_start_triage(args: argparse.Namespace) -> int:
    emit(start_watchtower_triage(workspace_path(args), scope=args.scope, task_id=args.task_id))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="switchboard", description="Switchboard filesystem task CLI.")
    subcommands = parser.add_subparsers(dest="command", required=True)

    init = subcommands.add_parser("init", help="Initialize .multi-code/switchboard.")
    init.add_argument("--workspace", required=True)
    init.set_defaults(func=cmd_init)

    list_cmd = subcommands.add_parser("list", help="List Switchboard tasks.")
    list_cmd.add_argument("--workspace", required=True)
    list_cmd.add_argument("--status", choices=FOLDER_STATUSES)
    list_cmd.set_defaults(func=cmd_list)

    show = subcommands.add_parser("show", help="Show one Switchboard task.")
    show.add_argument("--workspace", required=True)
    show.add_argument("task_id", metavar="uuid")
    show.set_defaults(func=cmd_show)

    create = subcommands.add_parser(
        "create",
        help="Create a Switchboard task.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Agent JSON schema for --input-json:
  {
    "title": "Short actionable task title",
    "description": "Concrete context, evidence, and expected outcome.",
    "priority": 1,
    "labels": ["watchtower", "security"],
    "identifier": "optional-human-readable-id",
    "source": {
      "type": "watchtower",
      "externalId": "watchtower_run:agent:random-uuid",
      "externalKey": "watchtower_run:agent",
      "externalUrl": null
    }
  }

Watchtower agents should create findings directly in the inbox:
  switchboard create --workspace /repo --inbox --input-json '{"title":"Fix auth redirect","description":"Evidence: src/main/auth.ts ...","source":{"type":"watchtower","externalId":"watchtower_...:agent:uuid"}}'
""",
    )
    create.add_argument("--workspace", required=True)
    create.add_argument("--title", help="Task title. Required unless supplied by --input-json.")
    create.add_argument("--description", default="", help="Task description. Overridden by --input-json.description when present.")
    create.add_argument("--inbox", action="store_true", help="Create the task in the Switchboard inbox instead of todo.")
    create.add_argument("--priority", type=float, help="Numeric priority. Overridden by --input-json.priority when present.")
    create.add_argument("--label", action="append", default=[], help="Task label. May be repeated. Overridden by --input-json.labels.")
    create.add_argument("--source-type", choices=sorted(SOURCE_TYPES), help="Source type for provenance.")
    create.add_argument("--source-external-id", help="Source external id for provenance.")
    create.add_argument("--source-external-key", help="Source external key for provenance.")
    create.add_argument("--source-external-url", help="Source external URL for provenance.")
    create.add_argument("--input-json", help="JSON object containing title, description, priority, labels, identifier, source, and comments.")
    create.set_defaults(func=cmd_create)

    import_task = subcommands.add_parser("import-task", help=argparse.SUPPRESS)
    import_task.add_argument("--workspace", required=True)
    import_task.add_argument("--input-json", required=True)
    import_task.set_defaults(func=cmd_import_task)

    read_all_cmd = subcommands.add_parser("read-all", help=argparse.SUPPRESS)
    read_all_cmd.add_argument("--workspace", required=True)
    read_all_cmd.set_defaults(func=cmd_read_all)

    update = subcommands.add_parser("update", help=argparse.SUPPRESS)
    update.add_argument("--workspace", required=True)
    update.add_argument("task_id", metavar="uuid")
    update.add_argument("--updates-json", required=True)
    update.set_defaults(func=cmd_update)

    comment = subcommands.add_parser("comment", help="Append a task comment.")
    comment.add_argument("--workspace", required=True)
    comment.add_argument("task_id", metavar="uuid")
    comment.add_argument("--body", required=True)
    comment.add_argument("--author")
    comment.add_argument("--kind", choices=sorted(COMMENT_KINDS), default="comment")
    comment.add_argument("--author-type", choices=sorted(AUTHOR_TYPES), default="user")
    comment.add_argument("--author-id")
    comment.set_defaults(func=cmd_comment)

    move = subcommands.add_parser("move", help="Move a task to another status.")
    move.add_argument("--workspace", required=True)
    move.add_argument("task_id", metavar="uuid")
    move.add_argument("--to", required=True, choices=TASK_STATUSES)
    move.set_defaults(func=cmd_move)

    promote = subcommands.add_parser("promote", help="Promote an inbox task to todo.")
    promote.add_argument("--workspace", required=True)
    promote.add_argument("task_id", metavar="uuid")
    promote.set_defaults(func=cmd_promote)

    cancel = subcommands.add_parser("cancel", help="Cancel a task.")
    cancel.add_argument("--workspace", required=True)
    cancel.add_argument("task_id", metavar="uuid")
    cancel.add_argument("--reason")
    cancel.set_defaults(func=cmd_cancel)

    claim = subcommands.add_parser("claim", help="Claim the next task from a claimable queue.")
    claim.add_argument("--workspace", required=True)
    claim.add_argument("--from", required=True, choices=CLAIMABLE_STATUSES, dest="from_status")
    claim.add_argument("--agent", required=True)
    claim.set_defaults(func=cmd_claim)

    publish = subcommands.add_parser("publish", help="Publish an owned task to the next queue.")
    publish.add_argument("--workspace", required=True)
    publish.add_argument("task_id", metavar="uuid")
    publish.add_argument("--to", required=True, choices=PUBLISH_TARGETS)
    publish.add_argument("--summary")
    publish.add_argument("--artifact", action="append", default=[])
    publish.add_argument("--command", action="append", default=[])
    publish.add_argument("--touched-file", action="append", default=[])
    publish.add_argument("--comment")
    publish.set_defaults(func=cmd_publish)

    recover = subcommands.add_parser("recover-lock", help="Recover a stale Switchboard folder lock.")
    recover.add_argument("--workspace", required=True)
    recover.add_argument("--status", required=True, choices=FOLDER_STATUSES)
    recover.set_defaults(func=cmd_recover_lock)

    requeue = subcommands.add_parser("requeue", help="Requeue an abandoned in-progress task.")
    requeue.add_argument("--workspace", required=True)
    requeue.add_argument("task_id", metavar="uuid")
    requeue.add_argument("--reason")
    requeue.set_defaults(func=cmd_requeue)

    runner = subcommands.add_parser("runner", help="Manage the persistent Switchboard runner.")
    runner_subcommands = runner.add_subparsers(dest="runner_command", required=True)

    runner_start_cmd = runner_subcommands.add_parser("start", help="Enable and start the persistent runner.")
    runner_start_cmd.add_argument("--workspace", required=True)
    runner_start_cmd.add_argument("--provider", choices=("local-process", "codex-app-server"), default="local-process")
    runner_start_cmd.add_argument("--cli", choices=("codex", "claude"), default="codex")
    runner_start_cmd.add_argument("--queue", action="append", choices=CLAIMABLE_STATUSES)
    runner_start_cmd.add_argument("--max-concurrency", type=int, default=1)
    runner_start_cmd.set_defaults(func=cmd_runner_start)

    runner_pause_cmd = runner_subcommands.add_parser("pause", help="Pause new runner claims.")
    runner_pause_cmd.add_argument("--workspace", required=True)
    runner_pause_cmd.set_defaults(func=cmd_runner_pause)

    runner_resume_cmd = runner_subcommands.add_parser("resume", help="Resume runner claims.")
    runner_resume_cmd.add_argument("--workspace", required=True)
    runner_resume_cmd.set_defaults(func=cmd_runner_resume)

    runner_stop_cmd = runner_subcommands.add_parser("stop", help="Stop the persistent runner backend.")
    runner_stop_cmd.add_argument("--workspace", required=True)
    runner_stop_cmd.set_defaults(func=cmd_runner_stop)

    runner_status_cmd = runner_subcommands.add_parser("status", help="Show runner state.")
    runner_status_cmd.add_argument("--workspace", required=True)
    runner_status_cmd.set_defaults(func=cmd_runner_status)

    runner_tick_cmd = runner_subcommands.add_parser("tick", help="Run one idempotent runner tick.")
    runner_tick_cmd.add_argument("--workspace", required=True)
    runner_tick_cmd.set_defaults(func=cmd_runner_tick)

    runner_run_cmd = runner_subcommands.add_parser("run", help="Run the local Switchboard backend.")
    runner_run_cmd.add_argument("--workspace", required=True)
    runner_run_cmd.add_argument("--once", action="store_true", help=argparse.SUPPRESS)
    runner_run_cmd.set_defaults(func=cmd_runner_run)

    execution = subcommands.add_parser("execution", help="Inspect Switchboard executions.")
    execution_subcommands = execution.add_subparsers(dest="execution_command", required=True)

    execution_status_cmd = execution_subcommands.add_parser("status", help="Show execution metadata.")
    execution_status_cmd.add_argument("--workspace", required=True)
    execution_status_cmd.add_argument("execution_id")
    execution_status_cmd.set_defaults(func=cmd_execution_status)

    execution_logs_cmd = execution_subcommands.add_parser("logs", help="Show execution log tail.")
    execution_logs_cmd.add_argument("--workspace", required=True)
    execution_logs_cmd.add_argument("execution_id")
    execution_logs_cmd.add_argument("--stream", choices=("stdout", "stderr"), required=True)
    execution_logs_cmd.add_argument("--tail", type=int, default=200)
    execution_logs_cmd.set_defaults(func=cmd_execution_logs)

    execution_stop_cmd = execution_subcommands.add_parser("stop", help="Stop an active Switchboard execution.")
    execution_stop_cmd.add_argument("--workspace", required=True)
    execution_stop_cmd.add_argument("execution_id")
    execution_stop_cmd.add_argument("--reason")
    execution_stop_cmd.set_defaults(func=cmd_execution_stop)

    execution_cleanup_cmd = execution_subcommands.add_parser("cleanup-worktree", help="Remove an execution worktree.")
    execution_cleanup_cmd.add_argument("--workspace", required=True)
    execution_cleanup_cmd.add_argument("execution_id")
    execution_cleanup_cmd.add_argument("--force", action="store_true")
    execution_cleanup_cmd.set_defaults(func=cmd_execution_worktree_cleanup)

    watchtower = subcommands.add_parser("watchtower", help="Manage Watchtower review runs.")
    watchtower_subcommands = watchtower.add_subparsers(dest="watchtower_command", required=True)

    watchtower_run_create = watchtower_subcommands.add_parser("run-create", help="Create a Watchtower review run.")
    watchtower_run_create.add_argument("--workspace", required=True)
    watchtower_run_create.add_argument("--preset", required=True)
    watchtower_run_create.add_argument("--status", choices=WATCHTOWER_RUN_STATUSES, default="pending", help=argparse.SUPPRESS)
    watchtower_run_create.add_argument("--agents-json", help=argparse.SUPPRESS)
    watchtower_run_create.set_defaults(func=cmd_watchtower_run_create)

    watchtower_run_status = watchtower_subcommands.add_parser("run-status", help="Show Watchtower review run metadata.")
    watchtower_run_status.add_argument("--workspace", required=True)
    watchtower_run_status.add_argument("run_id")
    watchtower_run_status.set_defaults(func=cmd_watchtower_run_status)

    watchtower_run_list = watchtower_subcommands.add_parser("run-list", help="List Watchtower review runs.")
    watchtower_run_list.add_argument("--workspace", required=True)
    watchtower_run_list.set_defaults(func=cmd_watchtower_run_list)

    watchtower_run_agent_status = watchtower_subcommands.add_parser("run-agent-status", help=argparse.SUPPRESS)
    watchtower_run_agent_status.add_argument("--workspace", required=True)
    watchtower_run_agent_status.add_argument("run_id")
    watchtower_run_agent_status.add_argument("agent_id")
    watchtower_run_agent_status.add_argument("--status", required=True, choices=WATCHTOWER_RUN_STATUSES)
    watchtower_run_agent_status.set_defaults(func=cmd_watchtower_run_agent_status)

    watchtower_start_review = watchtower_subcommands.add_parser("start-review", help="Start a runtime-owned Watchtower review run.")
    watchtower_start_review.add_argument("--workspace", required=True)
    watchtower_start_review.add_argument("--preset", required=True)
    watchtower_start_review.set_defaults(func=cmd_watchtower_start_review)

    watchtower_start_triage = watchtower_subcommands.add_parser("start-triage", help="Start a runtime-owned Watchtower inbox triage run.")
    watchtower_start_triage.add_argument("--workspace", required=True)
    watchtower_start_triage.add_argument("--scope", choices=("all", "selected"), default="all")
    watchtower_start_triage.add_argument("--task-id")
    watchtower_start_triage.set_defaults(func=cmd_watchtower_start_triage)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except SwitchboardError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, indent=2), file=sys.stderr)
        return 1
    except OSError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, indent=2), file=sys.stderr)
        return 1
