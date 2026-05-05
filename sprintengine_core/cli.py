"""Read-only Sprint Engine command line interface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, NoReturn

from .storage import (
    SprintEngineStorageError,
    get_run_status,
    inspect_run,
    list_runs,
    load_run,
)


JsonDict = dict[str, Any]
READ_ONLY_NOTICE = (
    "Sprint Engine Milestone 01 supports read/status/report commands only; "
    "mutation commands are intentionally unavailable"
)


class SprintEngineCliError(RuntimeError):
    """Raised for expected CLI failures with a concise operator-facing message."""


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args, unknown_args = parser.parse_known_args(sys.argv[1:] if argv is None else argv)
    if unknown_args and getattr(args, "handler", None) is not _unsupported_command:
        parser.error(f"unrecognized arguments: {' '.join(unknown_args)}")

    try:
        payload = _dispatch(args)
    except (SprintEngineCliError, SprintEngineStorageError) as exc:
        print(f"sprintengine: error: {exc}", file=sys.stderr)
        return 2

    print(_to_json(payload))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sprintengine",
        description="Read-only Sprint Engine CLI for local execution runs.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path.cwd(),
        help="Repository root to inspect. Defaults to the current directory.",
    )

    subparsers = parser.add_subparsers(dest="group", required=True)
    _add_run_parser(subparsers)
    _add_task_parser(subparsers)
    _add_artifact_parser(subparsers)
    _add_report_parser(subparsers)
    _add_unsupported_group(subparsers, "init")
    _add_unsupported_group(subparsers, "join")
    _add_unsupported_group(subparsers, "plan")
    _add_unsupported_group(subparsers, "agent")
    return parser


def _add_run_parser(subparsers: argparse._SubParsersAction) -> None:
    run = subparsers.add_parser("run", help="Read Sprint Engine run metadata.")
    actions = run.add_subparsers(dest="action", required=True)

    list_parser = actions.add_parser("list", help="List discovered runs.")
    list_parser.set_defaults(handler=_run_list)

    status_parser = actions.add_parser("status", help="Show run status.")
    status_parser.add_argument("run_id")
    status_parser.set_defaults(handler=_run_status)

    inspect_parser = actions.add_parser("inspect", help="Inspect a full run.")
    inspect_parser.add_argument("run_id")
    inspect_parser.set_defaults(handler=_run_inspect)

    _add_unsupported_action(actions, "create")
    _add_unsupported_action(actions, "update")
    _add_unsupported_action(actions, "delete")


def _add_task_parser(subparsers: argparse._SubParsersAction) -> None:
    task = subparsers.add_parser("task", help="Read Sprint Engine tasks.")
    actions = task.add_subparsers(dest="action", required=True)

    list_parser = actions.add_parser("list", help="List tasks for a run.")
    list_parser.add_argument("--run", required=True, dest="run_id")
    list_parser.set_defaults(handler=_task_list)

    for action in ("claim", "status", "log", "note", "next"):
        _add_unsupported_action(actions, action)


def _add_artifact_parser(subparsers: argparse._SubParsersAction) -> None:
    artifact = subparsers.add_parser(
        "artifact",
        help="Read Sprint Engine artifacts.",
    )
    actions = artifact.add_subparsers(dest="action", required=True)

    list_parser = actions.add_parser("list", help="List artifacts for a run.")
    list_parser.add_argument("--run", required=True, dest="run_id")
    list_parser.set_defaults(handler=_artifact_list)

    for action in ("add", "ready", "approve", "request-changes"):
        _add_unsupported_action(actions, action)


def _add_report_parser(subparsers: argparse._SubParsersAction) -> None:
    report = subparsers.add_parser("report", help="Export run reports.")
    actions = report.add_subparsers(dest="action", required=True)

    export = actions.add_parser("export", help="Export a deterministic report.")
    export.add_argument("--run", required=True, dest="run_id")
    export.add_argument("--format", choices=("json",), default="json")
    export.set_defaults(handler=_report_export)

    _add_unsupported_action(actions, "create")


def _add_unsupported_group(
    subparsers: argparse._SubParsersAction,
    name: str,
) -> None:
    parser = subparsers.add_parser(name, help=argparse.SUPPRESS)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    parser.set_defaults(handler=_unsupported_command)


def _add_unsupported_action(
    subparsers: argparse._SubParsersAction,
    name: str,
) -> None:
    parser = subparsers.add_parser(name, help=argparse.SUPPRESS)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    parser.set_defaults(handler=_unsupported_command)


def _dispatch(args: argparse.Namespace) -> JsonDict:
    handler = getattr(args, "handler", None)
    if handler is None:
        raise SprintEngineCliError("missing command handler")
    return handler(args)


def _run_list(args: argparse.Namespace) -> JsonDict:
    return {
        "ok": True,
        "runs": [run.to_dict() for run in list_runs(args.repo_root)],
    }


def _run_status(args: argparse.Namespace) -> JsonDict:
    return {
        "ok": True,
        "status": get_run_status(args.run_id, args.repo_root),
    }


def _run_inspect(args: argparse.Namespace) -> JsonDict:
    return {
        "ok": True,
        "state": inspect_run(args.run_id, args.repo_root).to_dict(),
    }


def _task_list(args: argparse.Namespace) -> JsonDict:
    state = load_run(args.run_id, args.repo_root)
    return {
        "ok": True,
        "run": state.run.to_dict(),
        "tasks": [task.to_dict() for task in state.tasks],
        "source": state.source.to_dict() if state.source is not None else None,
    }


def _artifact_list(args: argparse.Namespace) -> JsonDict:
    state = load_run(args.run_id, args.repo_root)
    return {
        "ok": True,
        "run": state.run.to_dict(),
        "artifacts": [artifact.to_dict() for artifact in state.artifacts],
        "source": state.source.to_dict() if state.source is not None else None,
    }


def _report_export(args: argparse.Namespace) -> JsonDict:
    if args.format != "json":
        raise SprintEngineCliError(f"unsupported report format: {args.format}")

    state = load_run(args.run_id, args.repo_root)
    return {
        "ok": True,
        "format": "json",
        "report": {
            "run": state.run.to_dict(),
            "tasks": [task.to_dict() for task in state.tasks],
            "artifacts": [artifact.to_dict() for artifact in state.artifacts],
            "agents": [agent.to_dict() for agent in state.agents],
            "events": [event.to_dict() for event in state.events],
            "evidenceSummaries": [
                {
                    "taskId": task.id,
                    "summary": task.evidence.summary,
                    "touchedFiles": list(task.evidence.touched_files),
                    "commandsRan": list(task.evidence.commands_ran),
                    "results": list(task.evidence.results),
                }
                for task in state.tasks
                if (
                    task.evidence.summary
                    or task.evidence.touched_files
                    or task.evidence.commands_ran
                    or task.evidence.results
                )
            ],
            "source": state.source.to_dict() if state.source is not None else None,
        },
    }


def _unsupported_command(args: argparse.Namespace) -> NoReturn:
    command = " ".join(
        str(value)
        for value in (getattr(args, "group", None), getattr(args, "action", None))
        if value
    )
    suffix = f" for '{command}'" if command else ""
    raise SprintEngineCliError(f"{READ_ONLY_NOTICE}{suffix}.")


def _to_json(payload: JsonDict) -> str:
    return json.dumps(payload, indent=2, sort_keys=True)
