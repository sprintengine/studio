from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .store import (
    CLAIMABLE_STATUSES,
    FOLDER_STATUSES,
    PUBLISH_TARGETS,
    TASK_STATUSES,
    SwitchboardError,
    add_comment,
    cancel_task,
    claim_task,
    create_task,
    find_task,
    init_workspace,
    move_task,
    promote_task,
    publish_task,
    read_all,
    record_for_output,
    recover_lock,
    requeue_task,
    task_summary,
    update_task,
    switchboard_root,
)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2))


def workspace_path(args: argparse.Namespace) -> Path:
    return Path(args.workspace)


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
    located = create_task(
        workspace_path(args),
        title=title,
        description=input_payload.get("description", args.description or ""),
        inbox=bool(input_payload.get("origin") == "watchtower" or args.inbox),
        identifier=input_payload.get("identifier"),
        priority=input_payload.get("priority"),
        labels=input_payload.get("labels"),
        source=input_payload.get("source"),
        comments=input_payload.get("comments"),
    )
    emit(mutation_payload(action="create", previous=None, record=record_for_output(located)))
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

    create = subcommands.add_parser("create", help="Create a Switchboard task.")
    create.add_argument("--workspace", required=True)
    create.add_argument("--title")
    create.add_argument("--description", default="")
    create.add_argument("--inbox", action="store_true")
    create.add_argument("--input-json", help=argparse.SUPPRESS)
    create.set_defaults(func=cmd_create)

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
