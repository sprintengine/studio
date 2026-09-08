"""Publish-time gate: a new test must be wired into `verify:app`.

The single most reproducible integration finding — 3 of 3 sprints merged
2026-07-23 — was "a sibling task wrote a test but never wired it into
verify:app", including the epic's own central-refactor suite
(`sprintRunStoreSlice.test.ts`). Every one of those was caught by a human
reading a diff at the END of the sprint, and catching them there is what
crowded real behavior seams out of integration scope.

So it moves to publish, mechanically. A task whose diff ADDS a `*.test.*` file
that no `verify:app`-reachable npm script runs, or ADDS a `test:*` script that
`verify:app` never reaches, cannot publish. This is a wiring fact, not a
judgment: the script graph either reaches the file or it does not.

Deliberately narrow:

- Only ADDED test files count. Editing an existing unwired test is somebody
  else's pre-existing debt, not this task's regression.
- Reachability is the real `npm run` graph walked from `verify:app`, so a test
  wired through an intermediate aggregate script counts as wired.
- A checkout with no `package.json`, or one whose `package.json` declares no
  `verify:app`, is out of scope and the gate is silent. Python engine tests are
  collected by pytest rather than named in a script, so they are out of scope
  here too — `tests/` is excluded by path.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set

VERIFY_SCRIPT = "verify:app"
_NPM_RUN = re.compile(r"npm run ([\w:.\-/]+)")
_TEST_FILE = re.compile(r"(^|/)[^/]+\.test\.[cm]?[jt]sx?$")
_ADDED_TEST_SCRIPT = re.compile(r'^\s*[+]\s*"(test:[^"]+)"\s*:')
# Paths whose tests are not run by npm scripts at all. `tests/` is the pytest
# tree (collected by directory, never named in package.json); node_modules is
# not ours to wire.
_OUT_OF_SCOPE_PREFIXES = ("tests/", "node_modules/")


def is_test_file(path: str) -> bool:
    normalized = str(path or "").replace("\\", "/").strip()
    if not normalized or normalized.startswith(_OUT_OF_SCOPE_PREFIXES):
        return False
    return bool(_TEST_FILE.search(normalized))


def load_package_scripts(root: Path) -> Dict[str, str]:
    """`package.json` scripts at `root`, or `{}` when there is nothing to read."""
    manifest = root / "package.json"
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    scripts = payload.get("scripts")
    if not isinstance(scripts, dict):
        return {}
    return {str(name): str(body) for name, body in scripts.items() if isinstance(body, str)}


def scripts_reachable_from(scripts: Dict[str, str], entry: str) -> Set[str]:
    """Every script `npm run entry` transitively invokes, including `entry`."""
    if entry not in scripts:
        return set()
    seen: Set[str] = set()
    pending = [entry]
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        pending.extend(_NPM_RUN.findall(scripts.get(name, "")))
    return seen


def _added_paths(task: Dict[str, Any]) -> List[str]:
    evidence = task.get("evidence")
    if not isinstance(evidence, dict):
        return []
    return [
        str(diff.get("path"))
        for diff in evidence.get("diffs") or []
        if isinstance(diff, dict) and diff.get("status") == "added" and diff.get("path")
    ]


def _added_test_scripts(task: Dict[str, Any]) -> List[str]:
    """`test:*` script names this task's diff ADDS to a package.json."""
    evidence = task.get("evidence")
    if not isinstance(evidence, dict):
        return []
    names: List[str] = []
    for diff in evidence.get("diffs") or []:
        if not isinstance(diff, dict):
            continue
        path = str(diff.get("path") or "").replace("\\", "/")
        if not path.endswith("package.json"):
            continue
        for hunk in diff.get("hunks") or []:
            if not isinstance(hunk, dict):
                continue
            for line in hunk.get("lines") or []:
                if not isinstance(line, dict) or line.get("type") != "added":
                    continue
                # Hunk lines carry content WITHOUT the diff prefix, and a
                # synthetic whole-file add records every line as `added` — so
                # one pass over added lines covers both a modified manifest and
                # a brand-new one.
                match = _ADDED_TEST_SCRIPT.match(f"+{line.get('content') or ''}")
                if match and match.group(1) not in names:
                    names.append(match.group(1))
    return names


def _referencing_scripts(scripts: Dict[str, str], test_path: str) -> Set[str]:
    normalized = test_path.replace("\\", "/")
    basename = normalized.rsplit("/", 1)[-1]
    # The basename fallback exists for a script that cds into a subdirectory
    # before naming the file, so it must only match a BARE mention. Matching the
    # basename anywhere let an unrelated script's longer path vouch for a new
    # file: this repo carries duplicated test basenames (as of 2026-09-08:
    # automations.test.ts, backlog.test.ts, conversation-peek.test.ts,
    # railState.test.ts, workspace-sync.test.ts), so a new
    # `src/anywhere/backlog.test.ts` that nothing runs read as wired because
    # `src/main/mobile/sprintengine/backlog.test.ts` is named by a wired script.
    # A gate that silently passes is the failure this item exists to close.
    bare = re.compile(rf"(?<![\w./-]){re.escape(basename)}")
    hits = set()
    for name, body in scripts.items():
        haystack = body.replace("\\", "/")
        if normalized in haystack or bare.search(haystack):
            hits.add(name)
    return hits


def unwired_test_publish_error(
    task: Dict[str, Any], roots: Iterable[Path]
) -> Optional[str]:
    """The refusal message for this task's unwired tests, or None to allow.

    `roots` are the checkouts this task's diff was captured from — the first one
    declaring a `verify:app` script owns the check. A task spanning repos where
    none declares `verify:app` is out of scope.
    """
    scripts: Dict[str, str] = {}
    for root in roots:
        candidate = load_package_scripts(Path(root))
        if VERIFY_SCRIPT in candidate:
            scripts = candidate
            break
    if not scripts:
        return None

    reachable = scripts_reachable_from(scripts, VERIFY_SCRIPT)
    problems: List[str] = []

    unwired_files = []
    for path in _added_paths(task):
        if not is_test_file(path):
            continue
        referencing = _referencing_scripts(scripts, path)
        if not referencing:
            unwired_files.append(f"{path} (no npm script runs it)")
        elif not referencing & reachable:
            unwired_files.append(
                f"{path} (only run by {', '.join(sorted(referencing))}, which `{VERIFY_SCRIPT}` never reaches)"
            )
    if unwired_files:
        problems.append(
            f"{len(unwired_files)} new test file(s) are not run by `{VERIFY_SCRIPT}`: "
            + "; ".join(unwired_files)
        )

    unwired_scripts = [
        name for name in _added_test_scripts(task) if name not in reachable
    ]
    if unwired_scripts:
        problems.append(
            f"{len(unwired_scripts)} new test script(s) are not reached by `{VERIFY_SCRIPT}`: "
            + ", ".join(unwired_scripts)
        )

    if not problems:
        return None
    return (
        "Cannot publish: "
        + " ".join(problems)
        + f". A test nothing runs is not coverage. Add a `test:*` script for each new test file "
        f"and reference it from `{VERIFY_SCRIPT}` (directly or through a suite script "
        f"`{VERIFY_SCRIPT}` already runs), then publish again."
    )
