"""A new test must be wired into `verify:app` before its task can publish.

The most reproducible integration finding across the three sprints merged
2026-07-23 — 3 of 3, including the epic's own central-refactor suite — was "a
sibling task wrote a test but never wired it into verify:app". Every one was
caught by a human reading a diff at the end of the sprint. This moves it to
publish, where it is a wiring fact rather than a judgment: the npm script graph
either reaches the file or it does not.

The narrowness is the design and is pinned here too — only ADDED test files
count, reachability follows the real `npm run` graph through intermediate
aggregate scripts, and a checkout with no `verify:app` is out of scope entirely.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from helpers import create_workspace_team, read_state, task, write_state
from sprintengine_core.tool.test_wiring import (
    is_test_file,
    load_package_scripts,
    scripts_reachable_from,
    unwired_test_publish_error,
)


def added(path: str, lines: list[str] | None = None) -> dict:
    return {
        "path": path,
        "status": "added",
        "hunks": [{"lines": [{"type": "added", "content": line} for line in (lines or [])]}],
    }


def task_with_diffs(diffs: list[dict]) -> dict:
    record = task("T1", "Add a suite", "developer")
    record["evidence"]["diffs"] = diffs
    return record


def write_package(root: Path, scripts: dict[str, str]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(json.dumps({"scripts": scripts}), encoding="utf-8")
    return root


# --- the pieces ---------------------------------------------------------------


def test_test_file_recognition() -> None:
    assert is_test_file("src/main/foo.test.ts")
    assert is_test_file("src/renderer/src/components/Bar.test.tsx")
    assert is_test_file("src/shared/baz.test.mjs")
    assert not is_test_file("src/main/foo.ts")
    assert not is_test_file("src/main/testing.ts")
    # The pytest tree is collected by directory and never named in a script, so
    # a gate that reads package.json has nothing true to say about it.
    assert not is_test_file("tests/sprintengine_tool/test_thing.py")
    assert not is_test_file("node_modules/pkg/index.test.js")


def test_reachability_walks_the_real_script_graph() -> None:
    scripts = {
        "verify:app": "npm run typecheck && npm run test:suite",
        "test:suite": "npm run test:main:alpha && npm run test:main:beta",
        "test:main:alpha": "node alpha.test.cjs",
        "test:main:beta": "node beta.test.cjs",
        "test:main:orphan": "node orphan.test.cjs",
        "typecheck": "tsc --noEmit",
    }
    reachable = scripts_reachable_from(scripts, "verify:app")
    # Two hops deep still counts as wired — the house style wires suites through
    # aggregates, and calling that unwired would be false.
    assert "test:main:alpha" in reachable and "test:main:beta" in reachable
    assert "test:main:orphan" not in reachable
    assert scripts_reachable_from(scripts, "no:such:script") == set()


def test_missing_or_unreadable_package_json_reads_as_no_scripts(tmp_path) -> None:
    assert load_package_scripts(tmp_path) == {}
    (tmp_path / "package.json").write_text("{ not json", encoding="utf-8")
    assert load_package_scripts(tmp_path) == {}


# --- the gate -----------------------------------------------------------------


def test_a_new_test_no_script_runs_refuses_publish(tmp_path) -> None:
    root = write_package(tmp_path, {"verify:app": "npm run test:main:alpha", "test:main:alpha": "node alpha.test.cjs"})
    error = unwired_test_publish_error(task_with_diffs([added("src/main/beta.test.ts")]), [root])
    assert error is not None
    assert "src/main/beta.test.ts" in error
    assert "no npm script runs it" in error
    # The refusal has to say what to do, not only that it refused.
    assert "verify:app" in error


def test_a_new_test_wired_only_outside_verify_app_refuses_publish(tmp_path) -> None:
    """The exact 3-of-3 finding: the script EXISTS, so the author believes the
    test runs. It just is not reachable from the gate anyone actually runs."""
    root = write_package(
        tmp_path,
        {
            "verify:app": "npm run test:main:alpha",
            "test:main:alpha": "node alpha.test.cjs",
            # Scripts here name the .ts SOURCE and build it to a .cjs bundle, so
            # the source path is what a wiring check can honestly match on.
            "test:main:beta": "esbuild beta.test.ts --outfile=beta.cjs && node beta.cjs",
        },
    )
    error = unwired_test_publish_error(task_with_diffs([added("beta.test.ts")]), [root])
    assert error is not None
    assert "test:main:beta" in error and "never reaches" in error


def test_a_properly_wired_new_test_publishes(tmp_path) -> None:
    root = write_package(
        tmp_path,
        {
            "verify:app": "npm run test:suite",
            "test:suite": "npm run test:main:beta",
            "test:main:beta": "esbuild src/main/beta.test.ts --outfile=beta.cjs && node beta.cjs",
        },
    )
    assert unwired_test_publish_error(task_with_diffs([added("src/main/beta.test.ts")]), [root]) is None


def test_a_new_test_script_verify_app_never_reaches_refuses_publish(tmp_path) -> None:
    root = write_package(tmp_path, {"verify:app": "npm run test:main:alpha", "test:main:alpha": "node alpha.test.cjs"})
    manifest_diff = {
        "path": "package.json",
        "status": "modified",
        "hunks": [{"lines": [{"type": "added", "content": '    "test:main:gamma": "node gamma.cjs",'}]}],
    }
    error = unwired_test_publish_error(task_with_diffs([manifest_diff]), [root])
    assert error is not None and "test:main:gamma" in error


def test_editing_an_existing_unwired_test_is_not_this_tasks_debt(tmp_path) -> None:
    root = write_package(tmp_path, {"verify:app": "npm run test:main:alpha", "test:main:alpha": "node alpha.test.cjs"})
    modified = {"path": "src/main/legacy.test.ts", "status": "modified", "hunks": []}
    assert unwired_test_publish_error(task_with_diffs([modified]), [root]) is None


def test_a_checkout_with_no_verify_app_is_out_of_scope(tmp_path) -> None:
    root = write_package(tmp_path, {"build": "tsc"})
    assert unwired_test_publish_error(task_with_diffs([added("src/beta.test.ts")]), [root]) is None
    assert unwired_test_publish_error(task_with_diffs([added("src/beta.test.ts")]), [tmp_path / "absent"]) is None


def test_the_first_root_declaring_verify_app_owns_the_check(tmp_path) -> None:
    """Worktree mode offers the task's own tree first, the workspace second. A
    secondary repo with no verify:app must not shadow the primary's gate."""
    secondary = write_package(tmp_path / "secondary", {"build": "tsc"})
    primary = write_package(tmp_path / "primary", {"verify:app": "npm run test:main:alpha", "test:main:alpha": "node a.cjs"})
    error = unwired_test_publish_error(task_with_diffs([added("src/beta.test.ts")]), [secondary, primary])
    assert error is not None and "src/beta.test.ts" in error


def test_non_test_files_never_trip_the_gate(tmp_path) -> None:
    root = write_package(tmp_path, {"verify:app": "npm run test:main:alpha", "test:main:alpha": "node a.cjs"})
    assert unwired_test_publish_error(task_with_diffs([added("src/main/feature.ts")]), [root]) is None


# --- end to end through `task publish` ----------------------------------------


def test_publish_is_refused_until_the_new_test_is_wired(tmp_path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    write_package(workspace, {"verify:app": "npm run test:main:alpha", "test:main:alpha": "node alpha.cjs"})
    (workspace / "src").mkdir()
    (workspace / "src" / "beta.test.ts").write_text("// a test nothing runs\n", encoding="utf-8")

    fixture = create_workspace_team(tmp_path, "ws", "wiring-e2e", [])
    state = read_state(fixture.state_path)
    blocked = task(
        "T1", "Add the beta suite", "developer",
        status="in_progress", owner="developer-1", owned_paths=["src/beta.test.ts"],
    )
    blocked["startedAt"] = "2026-07-27T00:00:00Z"
    state["tasks"] = [blocked]
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = ["developer"]
    write_state(fixture.state_path, state)

    refused = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T1", "--id", "developer-1",
        "--summary", "Added a suite.", "--path", "src/beta.test.ts",
    )
    assert "src/beta.test.ts" in refused.stderr
    assert "verify:app" in refused.stderr
    # A refused publish must leave the task where it was — the check runs before
    # the backstop commit precisely so nothing lands half-done.
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "in_progress"

    # Wire it, and the same publish goes through.
    (workspace / "package.json").write_text(
        json.dumps({
            "scripts": {
                "verify:app": "npm run test:main:alpha && npm run test:main:beta",
                "test:main:alpha": "node alpha.cjs",
                "test:main:beta": "node src/beta.test.ts",
            }
        }),
        encoding="utf-8",
    )
    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1",
        "--summary", "Added a suite and wired it.", "--path", "src/beta.test.ts",
    )
    assert published["ok"] is True
