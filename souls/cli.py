from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sprintengine_core.skill_layers import MULTICODE_LAYER_SKILLS

from .registry import get_soul, list_souls, render_soul, soul_path, validate_souls


def _json_result(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2)


def _display_path(path: Path) -> str:
    try:
        return str(path.relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def cmd_list(args: argparse.Namespace) -> int:
    souls = list_souls()
    if args.format == "json":
        print(_json_result({
            "ok": True,
            "souls": [
                {
                    "role": soul.role,
                    "label": soul.label,
                    "aliases": list(soul.aliases),
                    "path": _display_path(soul_path(soul.role)),
                }
                for soul in souls
            ],
        }))
        return 0

    for soul in souls:
        aliases = f" ({', '.join(soul.aliases)})" if soul.aliases else ""
        print(f"{soul.role}\t{soul.label}{aliases}")
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    # The portable soul is the role identity only. Multicode-managed spawns layer
    # the Multicode product skills (Backlog, Knowledge Graph) on top by default;
    # `--bare` renders the pack-portable soul without any host layer.
    extra_skills = () if args.bare else MULTICODE_LAYER_SKILLS
    try:
        soul = get_soul(args.role)
        content = render_soul(args.role, extra_skills=extra_skills)
        path = soul_path(args.role)
    except (KeyError, FileNotFoundError) as exc:
        return _fail("soul_not_found", str(exc), args.format)

    if args.format == "json":
        print(_json_result({
            "ok": True,
            "role": soul.role,
            "label": soul.label,
            "path": _display_path(path),
            "content": content,
        }))
        return 0

    print(content)
    return 0


def cmd_path(args: argparse.Namespace) -> int:
    try:
        path = soul_path(args.role)
    except KeyError as exc:
        return _fail("unknown_role", str(exc), args.format)
    if args.format == "json":
        soul = get_soul(args.role)
        print(_json_result({"ok": True, "role": soul.role, "path": _display_path(path)}))
    else:
        print(path)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    errors = validate_souls()
    if args.format == "json":
        print(_json_result({"ok": not errors, "errors": errors}))
    elif errors:
        print("Soul validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
    else:
        print("All Souls are valid.")
    return 1 if errors else 0


def _fail(code: str, message: str, output_format: str) -> int:
    if output_format == "json":
        print(_json_result({"ok": False, "error": code, "message": message}), file=sys.stderr)
    else:
        print(message, file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="souls",
        description="Read reusable agent Soul prompts.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("list", help="List available Souls.")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(handler=cmd_list)

    p = sub.add_parser("get", help="Print a Soul prompt.")
    p.add_argument("role", help="Soul role, for example architect, developer, or frontend.")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.add_argument(
        "--bare",
        action="store_true",
        help="Render only the portable soul identity, without the Multicode product skill layer.",
    )
    p.set_defaults(handler=cmd_get)

    p = sub.add_parser("path", help="Print the prompt file path for a Soul.")
    p.add_argument("role", help="Soul role, for example architect, developer, or frontend.")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(handler=cmd_path)

    p = sub.add_parser("validate", help="Validate that all Soul prompt files exist and are non-empty.")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(handler=cmd_validate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.handler(args)
