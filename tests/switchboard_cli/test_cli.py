from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]


def switchboard_command(args: list[str]) -> list[str]:
    if os.name == "nt":
        return [sys.executable, "-m", "switchboard_core", *args]
    return [str(REPO_ROOT / "scripts" / "switchboard"), *args]


def run_switchboard(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        switchboard_command(args),
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and completed.returncode != 0:
        raise AssertionError(f"switchboard failed\nargs={args}\nstdout={completed.stdout}\nstderr={completed.stderr}")
    return completed


def stdout_json(completed: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    return json.loads(completed.stdout)


def stderr_json(completed: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    return json.loads(completed.stderr)


class SwitchboardCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="multicode-switchboard-cli-")
        self.workspace = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_cli(self, args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
        return run_switchboard(args, check=check)

    def workspace_args(self) -> list[str]:
        return ["--workspace", str(self.workspace)]

    def task_file(self, folder_status: str, task_id: str) -> Path:
        if folder_status == "inbox":
            return self.workspace / ".multi-code" / "switchboard" / "inbox" / f"{task_id}.json"
        return self.workspace / ".multi-code" / "switchboard" / "tasks" / folder_status / f"{task_id}.json"

    def create_task(self, *, inbox: bool = False, title: str = "CLI task") -> dict[str, Any]:
        args = ["create", *self.workspace_args(), "--title", title, "--description", "Created by CLI test"]
        if inbox:
            args.append("--inbox")
        return stdout_json(self.run_cli(args))

    def test_init_creates_full_folder_model_and_locks(self) -> None:
        payload = stdout_json(self.run_cli(["init", *self.workspace_args()]))

        self.assertTrue(payload["ok"])
        root = self.workspace / ".multi-code" / "switchboard"
        expected = [
            root / "inbox",
            root / "tasks" / "planning",
            root / "tasks" / "todo",
            root / "tasks" / "ready",
            root / "tasks" / "in_progress",
            root / "tasks" / "testing",
            root / "tasks" / "testing_in_progress",
            root / "tasks" / "review",
            root / "tasks" / "review_in_progress",
            root / "tasks" / "done",
            root / "tasks" / "canceled",
        ]
        for folder in expected:
            self.assertTrue(folder.is_dir(), folder)
            self.assertEqual(json.loads((folder / "Lock").read_text(encoding="utf-8")), {"locked": False})
        self.assertTrue((root / "artifacts").is_dir())
        self.assertTrue((root / "watchtower-runs").is_dir())

    def test_create_list_show_and_comment_board_task(self) -> None:
        created = self.create_task(title="Board task")
        task_id = created["id"]

        self.assertEqual(created["nextFolder"], "todo")
        self.assertRegex(task_id, r"^[0-9a-f-]{36}$")
        self.assertTrue(self.task_file("todo", task_id).is_file())
        self.assertFalse(any(path.name.startswith("task_") for path in self.task_file("todo", task_id).parent.iterdir()))

        listed = stdout_json(self.run_cli(["list", *self.workspace_args(), "--status", "todo"]))
        self.assertEqual([task["id"] for task in listed["tasks"]], [task_id])
        self.assertEqual(listed["problems"], [])

        shown = stdout_json(self.run_cli(["show", *self.workspace_args(), task_id]))
        self.assertEqual(shown["record"]["task"]["title"], "Board task")
        self.assertEqual(shown["record"]["location"]["folderStatus"], "todo")

        commented = stdout_json(
            self.run_cli(["comment", *self.workspace_args(), task_id, "--body", "Needs focused validation.", "--author", "Reviewer"])
        )
        self.assertEqual(commented["nextFolder"], "todo")
        self.assertEqual(commented["record"]["task"]["comments"][-1]["body"], "Needs focused validation.")
        self.assertEqual(commented["record"]["task"]["comments"][-1]["author"]["name"], "Reviewer")

    def test_create_inbox_promote_and_cancel_with_reason(self) -> None:
        created = self.create_task(inbox=True, title="Inbox task")
        task_id = created["id"]

        self.assertEqual(created["nextFolder"], "inbox")
        self.assertTrue(self.task_file("inbox", task_id).is_file())

        promoted = stdout_json(self.run_cli(["promote", *self.workspace_args(), task_id]))
        self.assertEqual(promoted["previousFolder"], "inbox")
        self.assertEqual(promoted["nextFolder"], "todo")
        self.assertFalse(self.task_file("inbox", task_id).exists())
        self.assertTrue(self.task_file("todo", task_id).is_file())

        canceled = stdout_json(self.run_cli(["cancel", *self.workspace_args(), task_id, "--reason", "Duplicate of existing task."]))
        self.assertEqual(canceled["previousFolder"], "todo")
        self.assertEqual(canceled["nextFolder"], "canceled")
        self.assertTrue(self.task_file("canceled", task_id).is_file())
        bodies = [comment["body"] for comment in canceled["record"]["task"]["comments"]]
        self.assertIn("Duplicate of existing task.", bodies)

    def test_move_enforces_legal_transitions(self) -> None:
        created = self.create_task(title="Move task")
        task_id = created["id"]

        ready = stdout_json(self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"]))
        self.assertEqual(ready["previousFolder"], "todo")
        self.assertEqual(ready["nextFolder"], "ready")

        invalid = self.run_cli(["move", *self.workspace_args(), task_id, "--to", "done"], check=False)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("Cannot move Switchboard task from ready to done", stderr_json(invalid)["message"])

    def test_claim_moves_next_ready_task_and_records_claim_metadata(self) -> None:
        first = self.create_task(title="First ready task")["id"]
        second = self.create_task(title="Second ready task")["id"]
        self.run_cli(["move", *self.workspace_args(), first, "--to", "ready"])
        self.run_cli(["move", *self.workspace_args(), second, "--to", "ready"])

        claimed = stdout_json(self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"]))

        self.assertTrue(claimed["claimed"])
        self.assertEqual(claimed["previousFolder"], "ready")
        self.assertEqual(claimed["nextFolder"], "in_progress")
        self.assertIn(claimed["id"], {first, second})
        self.assertEqual(claimed["record"]["task"]["claim"]["owner"], "developer-1")
        remaining = second if claimed["id"] == first else first
        self.assertTrue(self.task_file("in_progress", claimed["id"]).is_file())
        self.assertTrue(self.task_file("ready", remaining).is_file())

    def test_claim_empty_queue_returns_structured_no_eligible_result(self) -> None:
        payload = stdout_json(self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"]))

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["claimed"])
        self.assertEqual(payload["message"], "No eligible task.")

    def test_publish_rejects_missing_implementation_evidence(self) -> None:
        task_id = self.create_task(title="Publish validation task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"])

        rejected = self.run_cli(["publish", *self.workspace_args(), task_id, "--to", "testing"], check=False)

        self.assertNotEqual(rejected.returncode, 0)
        message = stderr_json(rejected)["message"]
        self.assertIn("at least one execution attempt", message)
        self.assertIn("evidence summary", message)

    def test_publish_to_testing_accepts_valid_implementation_evidence(self) -> None:
        task_id = self.create_task(title="Publish success task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"])

        path = self.task_file("in_progress", task_id)
        task = json.loads(path.read_text(encoding="utf-8"))
        task["execution"]["attempts"].append(
            {
                "id": "attempt-1",
                "agentId": "developer-1",
                "startedAt": "2026-05-09T12:00:00Z",
                "completedAt": "2026-05-09T12:05:00Z",
                "summary": "Implemented CLI flow.",
            }
        )
        task["evidence"]["summary"] = "Implementation completed."
        task["evidence"]["commandsRun"] = ["python -m unittest tests.switchboard_cli.test_cli"]
        task["evidence"]["touchedFiles"] = ["switchboard_core/cli.py"]
        path.write_text(json.dumps(task, indent=2) + "\n", encoding="utf-8")

        published = stdout_json(self.run_cli(["publish", *self.workspace_args(), task_id, "--to", "testing"]))

        self.assertEqual(published["previousFolder"], "in_progress")
        self.assertEqual(published["nextFolder"], "testing")
        self.assertFalse(path.exists())
        self.assertTrue(self.task_file("testing", task_id).is_file())

    def test_publish_rejects_wrong_target(self) -> None:
        task_id = self.create_task(title="Wrong publish target")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"])

        rejected = self.run_cli(["publish", *self.workspace_args(), task_id, "--to", "done"], check=False)

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Cannot publish a task from in_progress to done", stderr_json(rejected)["message"])

    def test_show_reports_invalid_json_as_non_zero_error(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        task_id = "550e8400-e29b-41d4-a716-446655440000"
        path = self.task_file("todo", task_id)
        path.write_text("{not-json", encoding="utf-8")

        rejected = self.run_cli(["show", *self.workspace_args(), task_id], check=False)

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Invalid task JSON", stderr_json(rejected)["message"])


if __name__ == "__main__":
    unittest.main()
