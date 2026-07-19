#!/usr/bin/env python3
"""Sprint Engine coordination tool for specialist agents.

WARNING: Do not edit Sprint Engine run-store files directly.
All updates must go through this tool.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.diff_evidence import capture_task_diff_evidence
from sprintengine_core import store as folder_store

from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import *  # noqa: F403,F401
from sprintengine_core.tool.prompts import *  # noqa: F403,F401
from sprintengine_core.tool.state import *  # noqa: F403,F401
from sprintengine_core.tool.common import *  # noqa: F403,F401
from sprintengine_core.tool.comments import *  # noqa: F403,F401
from sprintengine_core.tool.tasks import *  # noqa: F403,F401
from sprintengine_core.tool.feedback import *  # noqa: F403,F401
from sprintengine_core.tool.artifacts import *  # noqa: F403,F401
from sprintengine_core.tool.plans import *  # noqa: F403,F401
from sprintengine_core.tool.phase_prompts import *  # noqa: F403,F401






































































































































# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

TOP_LEVEL_HELP = """\
Sprint Engine - all run-store mutations go through here. Never edit run-store files directly.

Entry points (CLI/human/headless compatibility; autonomous Multicode agents use MCP):
  sprintengine handover --name my-team --goal "..." --handover handover.md
  sprintengine init [--name "..."] [--goal "..."]                 # bootstraps the board; agents claim ready tasks separately
  sprintengine recover
  sprintengine projection
  sprintengine join --role developer --id developer-1 --watch
  sprintengine --backend mcp-local join --role developer --id developer-1 --watch
  sprintengine runner set --mode auto
  sprintengine runner set --mode off
  sprintengine triage needs-input --id architect
  sprintengine mcp serve --workspace . --extra-dir ./plugin/.sprintengine
  sprintengine merge start --id architect --target main

Roster commands (run-config only; MC-1591 removed membership add/retire/replenish/list — leases replace the roster):
  sprintengine roster configure --id architect --roles-json '[{"role":"developer","cli":"claude-code","model":"claude-opus-4-8"}]'
  sprintengine roster runtime --role developer --cli claude-code --model claude-haiku-4-5 --actor ui
  sprintengine roster enable --role tester --cli claude-code --actor ui

Registry inspection commands:
  sprintengine roles list
  sprintengine role get developer
  sprintengine soul get developer
  sprintengine skill list
  sprintengine skill get developer

Task commands:
  sprintengine task next   --role developer --id developer-1
  sprintengine task claim  --task-id T3 --id developer-1
  sprintengine task status --task-id T3 --status done --id developer-1
  sprintengine task status --task-id T3 --status needs_input --id developer-1 --needs-input-kind architect --needs-input-question "Acceptance conflicts with scoped paths"
  sprintengine task resolve-input --task-id T3 --id architect --resolution "Acceptance narrowed; continue with revised scope."
  sprintengine task release --task-id T3 --id architect --reason "Original worker inactive."
  sprintengine task status --task-id T3 --status done --id developer-1 --confidence-pct 85 --hallucination-risk-pct 10
  sprintengine task log    --task-id T3 --id developer-1 --summary "..." --file src/foo.ts --command "npm test" --result "Passed"
  sprintengine task log    --task-id T3 --id developer-1 --scope-expansion-json '{"path":"src/foo.test.ts","reason":"colocated regression test required for changed helper","risk":"low"}'
  sprintengine task note   --task-id T3 --id developer-1 --note "Blocked on X"
  sprintengine task list   --role developer
  sprintengine task refresh-ready

Plan commands (architect only):
  sprintengine plan add-task --title "..." --role developer --description "Concrete worker brief..." --path src/foo --acceptance "..." (add --note only for non-obvious details the description does not carry)
  sprintengine plan add-task --title "Review performance" --role performance --depends-on T4 --path src/foo --acceptance "Performance review artifact documents measured evidence, findings, or approval"
  sprintengine plan update-task --task-id T1 --title "..." --description "Concrete worker brief..." --path src/foo --acceptance "..." --note "Implementation detail..."
  sprintengine plan add-dependency --task-id T2 --depends-on T1
  sprintengine plan remove-dependency --task-id T2 --depends-on T1
  sprintengine plan delete-task --task-id T3 --unlink-dependents
  sprintengine plan start-review --role frontend --id frontend
  sprintengine plan review-status
  sprintengine plan address-reviews --actor architect
  sprintengine plan list

Artifact commands:
  sprintengine artifact add --task-id T1 --kind product_strategy --title "Strategy" --path .multi-code/sprintengine/team/documents/strategy.md --created-by product
  sprintengine artifact add --task-id T4 --kind code_review --title "Code review" --path .multi-code/sprintengine/team/reviews/review.md --created-by code-reviewer --recommended-task "Fix missing validation"
  sprintengine artifact add --task-id T4 --kind spec_review --title "Spec review" --path .multi-code/sprintengine/team/reviews/spec-review.md --created-by spec-reviewer --recommended-task "Implement missing acceptance path"
  sprintengine artifact add --task-id T5 --kind performance_review --title "Performance review" --path .multi-code/sprintengine/team/reviews/performance-review.md --created-by performance --recommended-task "Fix unbounded render work"
  sprintengine artifact list --task-id T1
  sprintengine artifact ready --artifact-id A1 --id product
  sprintengine artifact ready --artifact-id A1 --id product --confidence-pct 85 --hallucination-risk-pct 10
  sprintengine artifact approve --artifact-id A1 --id user
  sprintengine artifact request-changes --artifact-id A1 --id user --feedback "Tighten the scope."

Run summary:
  sprintengine summary
  sprintengine projection

MCP lifecycle compatibility:
  The local MCP server is the preferred agent operation boundary. The CLI remains
  a human/script/headless compatibility wrapper over the same core state
  mutations. Multicode-launched autonomous roster agents use the managed
  Sprint Engine MCP server and runtime dispatch, not `join --watch`; Multicode
  owns terminal wake/resume and restarts missing same-role capacity. Standalone
  or headless CLI users may still use `sprintengine join --watch`, where the
  CLI owns idle polling/backoff. Run the stdio server with
  `sprintengine mcp serve --workspace <path>` or
  `python -m sprintengine_mcp --workspace <path>`; repeated `--extra-dir`
  values add plugin registry roots containing roles/ and skills/. Use
  `--backend mcp-local` to exercise the MCP route from the CLI; set
  SPRINTENGINE_MCP_USER_ID and SPRINTENGINE_MCP_USER_AUTHORIZED=1 for mutating calls.

Cross-platform wrappers:
  POSIX shells: scripts/sprintengine --help
  Windows cmd.exe: scripts\\sprintengine.cmd --help
  Windows PowerShell fallback: & ".\\.venv\\Scripts\\python.exe" ".\\scripts\\sprintengine_tool.py" --help

Post-run merge:
  sprintengine merge start --id architect --target main
"""

def add_handover_parser(sub: argparse._SubParsersAction, name: str, help_text: str) -> None:
    from sprintengine_core.tool.commands import run as run_commands

    p = sub.add_parser(name, help=help_text)
    p.add_argument("--name", required=True, help="Team name; converted to a stable folder slug.")
    p.add_argument("--goal", default="", help="Goal for the future architect/sprintengine run.")
    handover = p.add_mutually_exclusive_group()
    handover.add_argument("--handover", type=Path, help="Path to markdown handover context to copy into handover.md.")
    handover.add_argument("--handover-text", help="Inline handover context to write to handover.md.")
    handover.add_argument("--handover-stdin", action="store_true", help="Read markdown handover context from stdin.")
    p.add_argument(
        "--source",
        action="append",
        default=[],
        help="Additional source bundle item as kind:path. Repeat for product_plan, architect_plan, html_mockup, design_notes, or generic_context.",
    )
    p.add_argument(
        "--source-plan-kind",
        default="unknown",
        choices=sorted(VALID_SOURCE_PLAN_KINDS),
        help="Meaning of the markdown source: unknown, product_plan, architect_plan, or epic.",
    )
    p.add_argument(
        "--reference-sources",
        dest="reference",
        action="store_true",
        help=(
            "Record file-backed sources (--handover markdown and every --source item) as project-root-relative "
            "references instead of copying them into the run store. The originals stay canonical and are read in place."
        ),
    )
    p.add_argument("--actor", default="handoff", help="Actor name for the team creation event.")
    p.add_argument("--agent", action="append", default=[], help="Selected roster member as role:id. Repeat for each specialist.")
    p.add_argument(
        "--use-worktrees",
        type=parse_bool,
        default=False,
        help="Run this team in a git worktree + branch per declared project, so agents work in isolated checkouts and commit per task.",
    )
    p.add_argument("--force", action="store_true", help="Replace existing run-store/handover bootstrap files.")
    p.set_defaults(handler=run_commands.handover, uses_state=False)


def add_feedback_arguments(parser: argparse.ArgumentParser) -> None:
    feedback = parser.add_argument_group("optional agent feedback")
    issue_categories = ", ".join(sorted(VALID_FEEDBACK_ISSUE_CATEGORIES))
    issue_severities = ", ".join(sorted(VALID_FEEDBACK_ISSUE_SEVERITIES))
    finding_kinds = ", ".join(sorted(VALID_FEEDBACK_FINDING_KINDS))
    finding_severities = ", ".join(sorted(VALID_FEEDBACK_FINDING_SEVERITIES))
    finding_areas = ", ".join(sorted(VALID_FEEDBACK_FINDING_AREAS))
    for attr, _, _ in FEEDBACK_SCORE_FIELDS:
        feedback.add_argument(
            f"--{attr.replace('_', '-')}",
            dest=attr,
            type=int,
            help="Optional feedback percentage from 0 to 100.",
        )
    for attr, _, _ in FEEDBACK_COUNT_FIELDS:
        feedback.add_argument(
            f"--{attr.replace('_', '-')}",
            dest=attr,
            type=int,
            help="Optional non-negative feedback count.",
        )
    feedback.add_argument("--review-target-task-id", help="Optional task id being reviewed.")
    feedback.add_argument("--review-target-agent-id", help="Optional agent id being reviewed.")
    feedback.add_argument("--review-target-execution-id", help="Optional execution id being reviewed.")
    feedback.add_argument("--top-friction", default="", help="Optional short note on the biggest friction point.")
    feedback.add_argument("--suggested-improvement", default="", help="Optional short prompt, task, or tool improvement suggestion.")
    feedback.add_argument(
        "--issue-json",
        action="append",
        default=[],
        help=(
            "Optional repeatable JSON object describing a prompt/process improvement issue. "
            "Required fields: category, severity, title, detail. "
            f"category: {issue_categories}. severity: {issue_severities}."
        ),
    )
    feedback.add_argument(
        "--finding-json",
        action="append",
        default=[],
        help=(
            "Optional repeatable JSON object describing a role-specific review finding. "
            "Required fields: kind, severity, area, title, detail. "
            f"kind: {finding_kinds}. severity: {finding_severities}. area: {finding_areas}."
        ),
    )

def add_implementer_difficulty_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--actual-difficulty-pct", dest="actual_difficulty_pct", type=int, help="Optional implementer actual difficulty percentage from 0 to 100.")
    parser.add_argument("--actual-difficulty-reason", default="", help="Optional short reason for the implementer actual difficulty.")

def add_architect_difficulty_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--difficulty-pct", dest="difficulty_pct", type=int, help="Optional architect estimated task difficulty percentage from 0 to 100.")
    parser.add_argument("--difficulty-reason", default="", help="Optional short reason for the architect difficulty estimate.")


def serve_mcp(args: argparse.Namespace) -> int:
    from sprintengine_mcp.server import main as mcp_main

    argv: list[str] = []
    if getattr(args, "http", False):
        argv.append("--http")
        argv.extend(["--host", str(args.host)])
        argv.extend(["--port", str(args.port)])
        if args.auth_token:
            argv.extend(["--auth-token", str(args.auth_token)])
    for workspace in args.workspace:
        argv.extend(["--workspace", str(workspace)])
    for allowed_root in args.allowed_root:
        argv.extend(["--allowed-root", str(allowed_root)])
    for extra_dir in args.extra_dir:
        argv.extend(["--extra-dir", str(extra_dir)])
    if args.user_dir:
        argv.extend(["--user-dir", str(args.user_dir)])
    return mcp_main(argv)


def build_parser() -> argparse.ArgumentParser:
    from sprintengine_core.tool.commands import artifact as artifact_commands
    from sprintengine_core.tool.commands import plan as plan_commands
    from sprintengine_core.tool.commands import registry as registry_commands
    from sprintengine_core.tool.commands import roster as roster_commands
    from sprintengine_core.tool.commands import run as run_commands
    from sprintengine_core.tool.commands import task as task_commands

    parser = argparse.ArgumentParser(
        description="Sprint Engine coordination tool",
        epilog=TOP_LEVEL_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--state",
        type=Path,
        default=None,
        help="Path to Sprint Engine run.yaml file (auto-detected from cwd).",
    )

    sub = parser.add_subparsers(dest="group", required=True)

    # handover
    add_handover_parser(sub, "handover", "Create a Sprint Engine team bootstrap and canonical handover.md.")

    # init
    p = sub.add_parser("init", help="Bootstrap the Sprint Engine run store.")
    p.add_argument("--name", help="Display name for the run; defaults to the team folder slug.")
    p.add_argument("--goal", help="Goal for the run.")
    p.add_argument("--agent", action="append", default=[], help="Selected roster member as role:id. Repeat for each specialist.")
    p.add_argument(
        "--role-runtimes-json",
        dest="role_runtimes_json",
        help='JSON object of role -> {"model", "cli"} recording the roster\'s per-role CLI model selection, stamped onto each task at claim.',
    )
    p.add_argument(
        "--configured-roles-json",
        dest="configured_roles_json",
        help="JSON array of the roster's enabled role ids: the roles a task may be tagged with. Enforced by plan.add_task, so a lazy (architect-only) roster still admits its planned tasks. Distinct from the seated agents and from --role-runtimes-json (which includes CLI-default roles).",
    )
    p.add_argument(
        "--roster-source",
        dest="roster_source",
        help="Who composes the roster: 'user' (default; picked in the wizard) or 'architect' ('Architect picks the team' — the architect enables roles via sprintengine.roster.configure). CLI-init-only; not MCP-mutable.",
    )
    p.add_argument(
        "--allowed-runtimes-json",
        dest="allowed_runtimes_json",
        help='JSON array of the sprint\'s allowed {"cli", "model"} runtimes (model null = the CLI default). The ticked per-sprint model selection; roster.configure hard-rejects any role assignment outside it. CLI-init-only; not MCP-mutable.',
    )
    p.add_argument(
        "--phase-runtimes-json",
        dest="phase_runtimes_json",
        help='JSON object of phase -> {"cli", "model"} (model null = the CLI default), e.g. {"review": {"cli": "claude-code", "model": "fable"}}. Premium mode: a stronger model reviews each task\'s diff as a fresh, diff-seeded session. Validated against --allowed-runtimes-json. Absent = the phase runs in-session on the owner\'s runtime and no extra sessions are created. CLI-init-only; not MCP-mutable.',
    )
    p.add_argument(
        "--required-sweeps-json",
        dest="required_sweeps_json",
        help='JSON array of sweep role ids the operator mandates for this run, e.g. ["tester", "security"]. The architect must plan one task per required role, and the run cannot complete until it has. Every id must name a registry sweep role. CLI-init-only; not MCP-mutable.',
    )
    p.add_argument(
        "--default-phases-json",
        dest="default_phases_json",
        help='JSON array of the post-implementation phases every task inherits, e.g. ["review"]. Default AND ceiling: a task may trim its phases with `plan add-task --phases`, never add one outside this set. `[]` means no review step (every publish with changes routes straight to done). Absent = ["review"]. CLI-init-only; not MCP-mutable.',
    )
    p.add_argument(
        "--use-worktrees",
        type=parse_bool,
        default=False,
        help="Run this team in a git worktree + branch per declared project, so agents work in isolated checkouts and commit per task.",
    )
    p.add_argument(
        "--repo",
        action="append",
        default=[],
        help=(
            "Another project this sprint spans, as <name>=<path>, for example --repo mobile=../multicode-mobile. "
            "Repeat per project; relative paths resolve against this project. Each must be a separate git project, "
            "and each gets its own run worktree on the run branch. Requires --use-worktrees true. Fixed at run creation."
        ),
    )
    p.add_argument(
        "--base-start-point",
        dest="base_start_point",
        help=(
            "Commit-ish the primary project's run worktree branches FROM (for example origin/main after a fetch), "
            "for chained sprints whose local branch may be behind its remote. Start point only: the stored baseRef "
            "(and the pull request base) stays the plain local branch name. Requires --use-worktrees true."
        ),
    )
    p.add_argument(
        "--source-json",
        dest="source_json",
        help="JSON object of the resolved root source metadata (kind/origin/path/planKind/capturedAt). App-created runs seed it into run.yaml so the Sprint Inbox shows the source before any agent runs handover.",
    )
    p.add_argument(
        "--source-bundle-json",
        dest="source_bundle_json",
        help="JSON array of resolved source bundle items (kind/origin/path/capturedAt) seeded into run.yaml alongside --source-json.",
    )
    p.set_defaults(handler=run_commands.init)

    # recover
    p = sub.add_parser("recover", help="Start integrity recovery mode and return the audit prompt.")
    p.set_defaults(handler=run_commands.recover)

    # projection
    p = sub.add_parser("projection", help="Read normalized Sprint Engine run projection.")
    p.set_defaults(handler=run_commands.projection)

    # roster — run-config ops only; membership (add/retire/replenish/list) was
    # deleted by MC-1591 when leases replaced the roster.
    roster_p = sub.add_parser("roster", help="Run-config operations (configuredRoles + per-role runtimes).")
    roster_sub = roster_p.add_subparsers(dest="action", required=True)

    p = roster_sub.add_parser("configure", help="Architect: enable roles + pick each role's cli/model ('Architect picks the team' runs, pre-plan-approval).")
    p.add_argument("--id", default="architect", help="Architect actor id recording the configuration.")
    p.add_argument(
        "--roles-json",
        dest="roles_json",
        required=True,
        help='JSON array of {"role", "cli", "model"} objects (model null = the CLI default). Each cli/model must exactly match an entry in the sprint\'s allowedRuntimes palette.',
    )
    p.set_defaults(handler=roster_commands.configure)

    p = roster_sub.add_parser("runtime", help="Operator: set one role's cli/model mid-run. Applies to future spawns and claims; live agents switch when they next start. App-owned (--actor ui), not an agent tool.")
    p.add_argument("--role", required=True)
    p.add_argument("--cli", required=True, help="CLI id, e.g. claude-code. Pass the role's current CLI when changing only the model.")
    p.add_argument("--model", help="Model id; omit for the CLI's default model (launches with no --model flag).")
    p.add_argument("--actor", default="user")
    p.set_defaults(handler=roster_commands.runtime)

    p = roster_sub.add_parser("enable", help="Operator: enable one more role for the run mid-flight (additive union into configuredRoles). App-owned (--actor ui), not an agent tool; agents route roster wishes through needs_input(user).")
    p.add_argument("--role", required=True)
    p.add_argument("--cli", help="Optional CLI id to seed the role's runtime in the same write.")
    p.add_argument("--model", help="Model id; only meaningful with --cli.")
    p.add_argument("--actor", default="user")
    p.set_defaults(handler=roster_commands.enable)

    # join
    p = sub.add_parser("join", help="Join Sprint Engine as worker, returns full role prompt.")
    p.add_argument("--role", required=True)
    p.add_argument("--id", required=True, help="Stable agent id, e.g. developer-1.")
    p.add_argument("--watch", action="store_true", help="Poll until work is available, Auto Mode is off, or the run is complete.")
    p.add_argument("--max-wait-seconds", type=float, help="Maximum watch duration before returning idle; primarily useful for tests and diagnostics.")
    p.set_defaults(handler=run_commands.join)

    # runner
    runner_p = sub.add_parser("runner", help="Runner policy operations.")
    runner_sub = runner_p.add_subparsers(dest="action", required=True)

    p = runner_sub.add_parser("status", help="Read the durable runner policy.")
    p.set_defaults(handler=run_commands.runner_status)

    p = runner_sub.add_parser("set", help="Update the durable runner policy.")
    # `--mode auto|off` is the legacy spelling. New canonical flag is
    # `--cli-watch-polling enabled|disabled`. The handler accepts either.
    p.add_argument("--mode", choices=["auto", "off"], help="DEPRECATED alias for --cli-watch-polling. auto = enabled, off = disabled.")
    p.add_argument("--cli-watch-polling", dest="cli_watch_polling", choices=["enabled", "disabled"], help="enabled = `join --watch` keeps polling for ready work; disabled = `join --watch` exits when no work is ready. CLI runtime only — Multicode supervisor ignores this flag.")
    p.add_argument("--poll-interval-seconds", type=int, help="Initial idle poll delay for join --watch.")
    p.add_argument("--idle-backoff-seconds", type=int, help="Base delay for subsequent idle join --watch polls.")
    p.add_argument("--max-backoff-seconds", type=int, help="Maximum capped delay for progressive idle join --watch backoff.")
    p.add_argument("--stop-when-complete", dest="stop_when_complete", action="store_true", default=None)
    p.add_argument("--continue-when-complete", dest="stop_when_complete", action="store_false")
    p.add_argument("--actor", default="user")
    p.set_defaults(handler=run_commands.runner_set)

    # triage
    triage_p = sub.add_parser("triage", help="Architect triage operations.")
    triage_sub = triage_p.add_subparsers(dest="action", required=True)

    p = triage_sub.add_parser("needs-input", help="Return architect prompt for architect-actionable needs_input blockers.")
    p.add_argument("--id", default="architect", help="Architect agent id.")
    p.set_defaults(handler=run_commands.triage_needs_input)

    # mcp
    mcp_p = sub.add_parser("mcp", help="Local MCP server operations.")
    mcp_sub = mcp_p.add_subparsers(dest="action", required=True)
    p = mcp_sub.add_parser("serve", help="Run the local Sprint Engine MCP server.")
    p.add_argument("--http", action="store_true", help="Serve MCP over local Streamable HTTP instead of stdio.")
    p.add_argument("--host", default="127.0.0.1", help="HTTP host for --http mode. Defaults to 127.0.0.1.")
    p.add_argument("--port", type=int, default=0, help="HTTP port for --http mode. Use 0 to choose a free port.")
    p.add_argument("--auth-token", help="Bearer token required by --http mode. Defaults to SPRINTENGINE_MCP_HTTP_TOKEN.")
    p.add_argument("--workspace", action="append", default=[], help="Workspace root allowed to contain Sprint Engine state paths.")
    p.add_argument("--allowed-root", action="append", default=[], help="Workspace root allowed to contain Sprint Engine state paths.")
    p.add_argument("--extra-dir", action="append", default=[], help="Additional plugin registry root containing roles/ and skills/.")
    p.add_argument("--user-dir", help="User registry base directory; the server reads <user-dir>/.sprintengine.")
    p.set_defaults(handler=serve_mcp, uses_state=False, raw_handler=True)

    # registry
    roles_p = sub.add_parser("roles", help="Inspect configured registry roles.")
    roles_sub = roles_p.add_subparsers(dest="action", required=True)
    p = roles_sub.add_parser("list", help="List configured registry roles.")
    p.add_argument("--include-shadowed", action="store_true", help="Include lower-precedence shadowed sources.")
    p.add_argument("--extra-dir", action="append", default=[], help="Additional plugin registry root containing roles/ and skills/.")
    p.set_defaults(handler=registry_commands.roles_list, uses_state=False)

    role_p = sub.add_parser("role", help="Inspect one configured registry role.")
    role_sub = role_p.add_subparsers(dest="action", required=True)
    p = role_sub.add_parser("get", help="Get a configured registry role by id or alias.")
    p.add_argument("role")
    p.add_argument("--extra-dir", action="append", default=[], help="Additional plugin registry root containing roles/ and skills/.")
    p.set_defaults(handler=registry_commands.role_get, uses_state=False)

    soul_p = sub.add_parser("soul", help="Inspect rendered registry Souls.")
    soul_sub = soul_p.add_subparsers(dest="action", required=True)
    p = soul_sub.add_parser("get", help="Render a configured registry Soul by role id or alias.")
    p.add_argument("role")
    p.add_argument("--run-id", default="", help="Optional run id for Soul template substitution.")
    p.add_argument("--extra-dir", action="append", default=[], help="Additional plugin registry root containing roles/ and skills/.")
    p.set_defaults(handler=registry_commands.soul_get, uses_state=False)

    skill_p = sub.add_parser("skill", help="Inspect configured registry skills.")
    skill_sub = skill_p.add_subparsers(dest="action", required=True)
    p = skill_sub.add_parser("list", help="List configured registry skills.")
    p.add_argument("--include-body", action="store_true", help="Include full skill bodies instead of body lengths.")
    p.add_argument("--extra-dir", action="append", default=[], help="Additional plugin registry root containing roles/ and skills/.")
    p.set_defaults(handler=registry_commands.skills_list, uses_state=False)

    p = skill_sub.add_parser("get", help="Get a configured registry skill by id.")
    p.add_argument("skill")
    p.add_argument("--extra-dir", action="append", default=[], help="Additional plugin registry root containing roles/ and skills/.")
    p.set_defaults(handler=registry_commands.skill_get, uses_state=False)

    # task
    task_p = sub.add_parser("task", help="Task operations.")
    task_sub = task_p.add_subparsers(dest="action", required=True)

    p = task_sub.add_parser("next", help="Claim the next ready task for your role.")
    p.add_argument("--role", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--model", help="CLI model to record on the claimed task. Overrides MULTICODE_AGENT_MODEL; Multicode injects that env at launch, so this is for headless/non-Multicode CLI use.")
    p.add_argument("--cli", help="CLI the recorded model belongs to. Overrides MULTICODE_AGENT_CLI.")
    p.set_defaults(handler=task_commands.next_task)

    p = task_sub.add_parser("claim", help="Claim a specific task by ID.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id.")
    p.add_argument("--model", help="CLI model to record on the claimed task. Overrides MULTICODE_AGENT_MODEL; Multicode injects that env at launch, so this is for headless/non-Multicode CLI use.")
    p.add_argument("--cli", help="CLI the recorded model belongs to. Overrides MULTICODE_AGENT_CLI.")
    p.set_defaults(handler=task_commands.claim)

    p = task_sub.add_parser("status", help="Update task status.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--status", required=True, choices=sorted(VALID_TASK_STATUSES))
    p.add_argument("--id", help="Agent id.")
    p.add_argument("--summary", help="Completion summary (used when status=done).")
    p.add_argument("--needs-input-kind", choices=NEEDS_INPUT_KIND_INPUT_CHOICES, help="Classify a needs_input blocker for routing. `architect` (alias `planner`) routes to the run's planning role.")
    p.add_argument("--needs-input-reason", choices=sorted(VALID_NEEDS_INPUT_REASONS), help="Why the task needs input; kind is the actor who must act.")
    p.add_argument("--needs-input-artifact-id", help="Artifact id related to an artifact_review blocker.")
    p.add_argument("--needs-input-question", help="Question or blocker that requires input.")
    p.add_argument("--needs-input-suggested-resolution", help="Optional proposed unblock path.")
    add_implementer_difficulty_arguments(p)
    add_feedback_arguments(p)
    p.set_defaults(handler=task_commands.status)

    p = task_sub.add_parser("resolve-input", help="Resolve a needs_input blocker and notify the owner to resume or stop.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Actor id resolving the input.")
    p.add_argument("--resolution", required=True, help="Concrete resolution for the waiting owner.")
    p.add_argument("--complete", action="store_true", help="Mark the task done instead of resuming the owner.")
    p.set_defaults(handler=task_commands.resolve_input)

    p = task_sub.add_parser("release", help="Release an active task from its owner and return it to the ready queue.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Actor id releasing the task.")
    p.add_argument("--reason", required=True, help="Why the task is being released.")
    p.set_defaults(handler=task_commands.release)

    p = task_sub.add_parser("refresh-ready", help="Refresh the materialized ready queue from the run DAG.")
    p.set_defaults(handler=task_commands.refresh_ready)

    p = task_sub.add_parser("log", help="Log work evidence (files, commands, results).")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id.")
    p.add_argument("--summary")
    p.add_argument("--file", action="append", metavar="PATH")
    p.add_argument("--command", action="append", metavar="CMD")
    p.add_argument("--result", action="append", metavar="RESULT")
    p.add_argument(
        "--scope-expansion-json",
        action="append",
        help='Repeatable JSON object for a justified touched file outside ownedPaths, e.g. {"path":"src/foo.test.ts","reason":"needed colocated regression test","risk":"low"}.',
    )
    # Sweep assessment channel: a no-phase sweep records per-audited-task
    # telemetry here (the --review-target-* trio + counts/findings), since it
    # never enters a phase walk and publish carries no feedback fields.
    add_feedback_arguments(p)
    p.set_defaults(handler=task_commands.log)

    p = task_sub.add_parser("publish", help="Publish the implementation summary; the engine routes the task into its phase walk (or straight to done when it produced no changes).")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id.")
    p.add_argument("--summary", required=True, help="Implementation summary or rework response body.")
    p.add_argument("--path", action="append", default=[], help="Project-root-relative path referenced by this handoff.")
    p.add_argument("--summary-data-json", help="Structured implementation summary JSON object.")
    add_implementer_difficulty_arguments(p)
    p.set_defaults(handler=task_commands.publish)

    p = task_sub.add_parser("advance", help="Close the task's current phase and step forward. Owner-only.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id. Must be the task owner.")
    p.add_argument("--phase", required=True, choices=sorted(VALID_TASK_PHASES), help="The phase you are closing. Must equal the task's current status.")
    p.add_argument("--outcome", required=True, choices=sorted(VALID_PHASE_OUTCOMES), help="pass = nothing to fix; pass_with_fixes = you found and fixed issues; escalate = a plan/scope/product decision blocks you.")
    p.add_argument("--summary", required=True, help="Short rationale for agent readers (~280 chars).")
    p.add_argument("--needs-input-kind", choices=NEEDS_INPUT_KIND_INPUT_CHOICES, help="Escalation routing actor. `architect` (alias `planner`) routes to the run's planning role.")
    p.add_argument("--needs-input-reason", choices=sorted(VALID_NEEDS_INPUT_REASONS), help="Escalation reason.")
    p.add_argument("--needs-input-question", help="Escalation question. Required with --outcome escalate.")
    p.add_argument("--needs-input-suggested-resolution", help="Optional proposed unblock path.")
    add_feedback_arguments(p)
    p.set_defaults(handler=task_commands.advance)

    p = task_sub.add_parser("note", help="Add a freeform note to a task.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id.")
    p.add_argument("--note", required=True)
    p.set_defaults(handler=task_commands.note)

    p = task_sub.add_parser("comment", help="Add or list structured task comments.")
    p.add_argument("comment_action", nargs="?", choices=["add", "list"], default="add")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", default="user", help="Actor id.")
    p.add_argument("--body")
    p.add_argument("--source", default="user", choices=["user", "agent", "system"])
    p.add_argument("--type", dest="comment_type", choices=sorted(VALID_TASK_COMMENT_TYPES))
    p.add_argument("--path", action="append", default=[], help="Project-root-relative path referenced by this comment.")
    p.add_argument("--data-json", help="Structured comment data JSON object.")
    p.set_defaults(handler=task_commands.comment)

    p = task_sub.add_parser("list", help="List ready tasks for a role.")
    p.add_argument("--role")
    p.set_defaults(handler=task_commands.list_tasks)

    # plan
    plan_p = sub.add_parser("plan", help="Plan operations (architect only).")
    plan_sub = plan_p.add_subparsers(dest="action", required=True)

    p = plan_sub.add_parser("add-task", help="Append a planned task to the board.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id")
    p.add_argument("--title", required=True)
    p.add_argument("--description", default="", help="Concrete task brief for the worker: what changes, target behavior, boundary, non-goals.")
    p.add_argument("--role", required=True)
    p.add_argument("--repo", help="Project this task works in, from the ones the sprint declares. Omit for the sprint's main project.")
    p.add_argument("--depends-on", action="append", default=[])
    p.add_argument("--path", action="append", default=[], help="Owned path or directory, relative to the task's project root.")
    p.add_argument("--acceptance", action="append", default=[], help="Externally verifiable acceptance criterion; never a restatement of the description.")
    p.add_argument("--note", action="append", default=[], help="Repeatable non-obvious implementation detail the description does not already carry; omit when the description suffices.")
    p.add_argument("--task-note", action="append", default=[], help="Repeatable task note.")
    p.add_argument("--produces-implementation", action="store_true", help="Mark this task as implementation-producing even when its role is not developer/frontend.")
    p.add_argument("--product-facing", action="store_true", help="Mark this task as requiring product acceptance when product is rostered.")
    p.add_argument("--not-product-facing", action="store_true", help="Persist that this task should not receive product acceptance by default.")
    p.add_argument("--needs-triage", action="store_true", help="Create the task as an architect-triage candidate that is not claimable until cleared.")
    p.add_argument("--phases", help="Comma-separated post-implementation phases for this task (e.g. \"review\"). Must be a subset of the run\'s defaultPhases. Pass \"\" for none (publish routes straight to done). Omit to inherit the run default.")
    add_architect_difficulty_arguments(p)
    p.set_defaults(handler=plan_commands.add_task)

    p = plan_sub.add_parser("update-task", help="Edit an existing planned task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--title")
    p.add_argument("--description", help="Concrete task brief for the worker.")
    p.add_argument("--clear-description", action="store_true")
    p.add_argument("--role")
    p.add_argument("--repo", help="Re-target this task at another project the sprint declares.")
    p.add_argument("--path", action="append", help="Replace owned paths with this repeatable list.")
    p.add_argument("--clear-paths", action="store_true")
    p.add_argument("--acceptance", action="append", help="Replace acceptance criteria with this repeatable list.")
    p.add_argument("--clear-acceptance", action="store_true")
    p.add_argument("--note", action="append", help="Replace implementation notes with this repeatable list; only non-obvious details the description does not already carry.")
    p.add_argument("--clear-notes", action="store_true")
    p.add_argument("--task-note", action="append", help="Replace task notes with this repeatable list.")
    p.add_argument("--clear-task-notes", action="store_true")
    p.add_argument("--produces-implementation", action="store_true", help="Mark this task as implementation-producing even when its role is not developer/frontend.")
    p.add_argument("--product-facing", action="store_true", help="Mark this task as requiring product acceptance when product is rostered.")
    p.add_argument("--not-product-facing", action="store_true", help="Persist that this task should not receive product acceptance by default.")
    p.add_argument("--needs-triage", action="store_true", help="Mark the task as an architect-triage candidate that is not claimable until cleared.")
    p.add_argument("--clear-needs-triage", action="store_true", help="Clear the task's architect-triage candidate flag.")
    p.add_argument("--phases", help="Comma-separated post-implementation phases for this task (e.g. \"review\"). Must be a subset of the run\'s defaultPhases. Pass \"\" for none (publish routes straight to done). Omit to inherit the run default.")
    add_architect_difficulty_arguments(p)
    p.add_argument("--force", action="store_true", help="Allow editing an active or completed task.")
    p.set_defaults(handler=plan_commands.update_task)

    p = plan_sub.add_parser("delete-task", help="Delete a planned task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--unlink-dependents", action="store_true", help="Remove this task from dependent tasks before deleting it.")
    p.add_argument("--force", action="store_true", help="Allow deleting an active or completed task.")
    p.set_defaults(handler=plan_commands.delete_task)

    p = plan_sub.add_parser("add-dependency", help="Add dependency links to a task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--depends-on", action="append", required=True)
    p.add_argument("--force", action="store_true", help="Allow editing an active or completed task.")
    p.set_defaults(handler=plan_commands.add_dependency)

    p = plan_sub.add_parser("remove-dependency", help="Remove dependency links from a task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--depends-on", action="append", required=True)
    p.add_argument("--force", action="store_true", help="Allow editing an active or completed task.")
    p.set_defaults(handler=plan_commands.remove_dependency)

    p = plan_sub.add_parser("start-review", help="Start a specialist review of the architect plan.")
    p.add_argument("--role", required=True)
    p.add_argument("--id", required=True, help="Stable agent id, e.g. frontend or developer-1.")
    p.set_defaults(handler=plan_commands.start_review)

    p = plan_sub.add_parser("review-status", help="Summarize specialist plan review files.")
    p.set_defaults(handler=plan_commands.review_status)

    p = plan_sub.add_parser("address-reviews", help="Start architect mode for addressing plan review feedback.")
    p.add_argument("--actor", default="architect")
    p.set_defaults(handler=plan_commands.address_reviews)

    p = plan_sub.add_parser("list", help="List planned tasks.")
    p.set_defaults(handler=plan_commands.list_tasks)

    # artifact
    artifact_p = sub.add_parser("artifact", help="Review artifact operations.")
    artifact_sub = artifact_p.add_subparsers(dest="action", required=True)

    p = artifact_sub.add_parser("add", help="Register a review artifact linked to a producing task.")
    p.add_argument("--actor", default="agent", help="Actor recording the artifact registration.")
    p.add_argument("--artifact-id", help="Stable artifact id. Defaults to the next A<number> id.")
    p.add_argument("--task-id", required=True, help="Producing task id.")
    p.add_argument("--kind", required=True, choices=sorted(VALID_ARTIFACT_KINDS))
    p.add_argument("--title", required=True, help="Human-readable review title.")
    p.add_argument("--path", required=True, help="Artifact file path under the active Sprint Engine team folder.")
    p.add_argument("--created-by", help="Agent or actor that produced the artifact.")
    p.add_argument("--recommended-task", action="append", default=[], help="Optional downstream task recommendation.")
    p.add_argument("--ready", action="store_true", help="Immediately mark the artifact ready for review.")
    p.set_defaults(handler=artifact_commands.add)

    p = artifact_sub.add_parser("list", help="List review artifacts.")
    p.add_argument("--task-id", help="Filter by linked producing task id.")
    p.add_argument("--kind", choices=sorted(VALID_ARTIFACT_KINDS), help="Filter by artifact kind.")
    p.add_argument("--status", choices=sorted(VALID_ARTIFACT_STATUSES), help="Filter by artifact status.")
    p.set_defaults(handler=artifact_commands.list_artifacts)

    p = artifact_sub.add_parser("ready", help="Mark an artifact ready for human review and move its task to needs_input.")
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--id", required=True, help="Actor or agent id.")
    add_feedback_arguments(p)
    p.set_defaults(handler=artifact_commands.ready)

    p = artifact_sub.add_parser("approve", help="Approve an artifact and complete its task when all linked artifacts are approved.")
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--id", required=True, help="Approving actor id.")
    p.add_argument("--approval-mode", choices=sorted(VALID_APPROVAL_MODES), help="Approval provenance: 'manual' (human) or 'policy' (run auto-approval). Optional; omit for a plain approval.")
    p.set_defaults(handler=artifact_commands.approve)

    p = artifact_sub.add_parser("request-changes", help="Request artifact changes, record feedback, and reopen the linked task.")
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--id", required=True, help="Reviewing actor id.")
    p.add_argument("--feedback", required=True, help="Feedback to append to the linked task.")
    p.set_defaults(handler=artifact_commands.request_changes)

    # cancel
    p = sub.add_parser(
        "cancel",
        help="Cancel the run: status canceled, non-done tasks canceled, owners/leases released, one run_canceled event. Done tasks and any run worktree/branch are left in place.",
    )
    p.add_argument("--id", default="user", help="Actor id performing the cancel.")
    p.set_defaults(handler=run_commands.cancel)

    # summary
    p = sub.add_parser("summary", help="Print final run summary.")
    p.set_defaults(handler=run_commands.summary)

    # merge
    merge_p = sub.add_parser("merge", help="Post-run merge instructions.")
    merge_sub = merge_p.add_subparsers(dest="action", required=True)
    p = merge_sub.add_parser("start", help="Return canonical architect merge instructions.")
    p.add_argument("--id", required=True, help="Architect actor id.")
    p.add_argument("--target", required=True, help="Target branch for the user-authorized merge.")
    p.set_defaults(handler=run_commands.merge_start)

    # vcs (shared run worktree)
    vcs_p = sub.add_parser("vcs", help="Shared run-worktree git operations (worktree mode only).")
    vcs_sub = vcs_p.add_subparsers(dest="action", required=True)

    p = vcs_sub.add_parser("status", help="Report the run worktree branch, path, and dirty state.")
    p.set_defaults(handler=run_commands.vcs_status)

    p = vcs_sub.add_parser("commit", help="Commit your task's changes in its project's run worktree (serialized by that project's commit lock).")
    p.add_argument("--task-id", required=True, help="Task whose changes you are committing.")
    p.add_argument("--id", required=True, help="Your agent id.")
    p.add_argument("--summary", help="Optional implementation summary to record on the task before committing.")
    p.add_argument("--path", action="append", default=[], help="Extra project-root-relative path to include beyond the task's owned and logged paths.")
    p.set_defaults(handler=run_commands.vcs_commit)

    p = vcs_sub.add_parser("pr", help="Push the run worktree branch and open a pull request via the GitHub CLI.")
    p.add_argument("--id", default="architect", help="Actor id opening the pull request.")
    p.add_argument("--base", help="Target base branch for the pull request. Defaults to the recorded base ref.")
    p.add_argument("--title", help="Pull request title.")
    p.add_argument("--body", help="Pull request body.")
    p.add_argument("--draft", action="store_true", help="Open the pull request as a draft.")
    p.add_argument("--no-push", dest="no_push", action="store_true", help="Skip pushing the branch; only attempt PR creation.")
    p.set_defaults(handler=run_commands.vcs_pr)

    p = vcs_sub.add_parser("pr-status", help="Resolve and persist whether the run branch has merged (PR state or branch ancestry).")
    p.set_defaults(handler=run_commands.vcs_pr_status)

    p = vcs_sub.add_parser(
        "pr-merge",
        help="Merge one project's pull request via the GitHub CLI. Refuses while a project it depends on is unmerged.",
    )
    p.add_argument("--repo", default="primary", help="Declared project whose pull request to merge. Defaults to this project.")
    p.add_argument("--method", default="merge", choices=["merge", "squash", "rebase"], help="How GitHub should land the branch.")
    p.add_argument("--id", default="user", help="Actor id performing the merge.")
    p.set_defaults(handler=run_commands.vcs_pr_merge)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "uses_state", True):
        state_path = args.state or default_state_path()
        reject_invalid_posix_state_path(state_path)
        args.state = state_path.resolve()
    elif args.state is not None:
        reject_invalid_posix_state_path(args.state)
        args.state = args.state.resolve()
    if getattr(args, "raw_handler", False):
        return int(args.handler(args))
    result = args.handler(args)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
