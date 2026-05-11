from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from switchboard_core.store import runner_command_for


REPO_ROOT = Path(__file__).resolve().parents[2]


def switchboard_command(args: list[str]) -> list[str]:
    if os.name == "nt":
        return [sys.executable, "-m", "switchboard_core", *args]
    return [str(REPO_ROOT / "scripts" / "switchboard"), *args]


def run_switchboard(args: list[str], *, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        switchboard_command(args),
        cwd=REPO_ROOT,
        env={**os.environ, **(env or {})},
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


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class SwitchboardCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="multicode-switchboard-cli-")
        self.workspace = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_cli(self, args: list[str], *, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return run_switchboard(args, check=check, env=env)

    def workspace_args(self) -> list[str]:
        return ["--workspace", str(self.workspace)]

    def init_git_repo(self) -> None:
        subprocess.run(["git", "init"], cwd=self.workspace, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        subprocess.run(["git", "config", "user.email", "switchboard@example.test"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.name", "Switchboard Test"], cwd=self.workspace, check=True)
        (self.workspace / "README.md").write_text("switchboard test workspace\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.workspace, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.workspace, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)

    def task_file(self, folder_status: str, task_id: str) -> Path:
        if folder_status == "inbox":
            return self.workspace / ".multi-code" / "switchboard" / "inbox" / f"{task_id}.json"
        return self.workspace / ".multi-code" / "switchboard" / "tasks" / folder_status / f"{task_id}.json"

    def create_task(self, *, inbox: bool = False, title: str = "CLI task") -> dict[str, Any]:
        args = ["create", *self.workspace_args(), "--title", title, "--description", "Created by CLI test"]
        if inbox:
            args.append("--inbox")
        return stdout_json(self.run_cli(args))

    def fake_cli_on_path(self, name: str) -> Path:
        path = self.workspace / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
        return path

    def test_runner_command_for_codex_uses_non_interactive_exec(self) -> None:
        codex = self.fake_cli_on_path("codex")

        with patch.dict(os.environ, {"PATH": str(self.workspace)}, clear=True):
            command = runner_command_for({"cli": "codex"})

        self.assertEqual(command, [str(codex), "exec", "--dangerously-bypass-approvals-and-sandbox", "-"])

    def test_runner_command_for_claude_uses_non_interactive_print(self) -> None:
        claude = self.fake_cli_on_path("claude")

        with patch.dict(os.environ, {"PATH": str(self.workspace)}, clear=True):
            command = runner_command_for({"cli": "claude"})

        self.assertEqual(command, [str(claude), "--print", "--permission-mode", "bypassPermissions"])

    def test_runner_command_for_override_is_preserved(self) -> None:
        with patch.dict(os.environ, {"SWITCHBOARD_LOCAL_PROCESS_COMMAND": "python3 -c pass"}, clear=True):
            command = runner_command_for({"cli": "codex"})

        self.assertEqual(command, ["python3", "-c", "pass"])

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
        self.assertTrue((root / "runner").is_dir())
        self.assertTrue((root / "runner" / "events.jsonl").is_file())
        self.assertTrue((root / "executions").is_dir())

    def test_watchtower_run_create_status_and_list(self) -> None:
        created = stdout_json(
            self.run_cli(["watchtower", "run-create", *self.workspace_args(), "--preset", "lean_code_review"])
        )

        self.assertTrue(created["ok"])
        run = created["run"]
        self.assertRegex(run["runId"], r"^watchtower_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$")
        self.assertEqual(run["status"], "pending")
        self.assertEqual(run["preset"], "lean_code_review")
        self.assertEqual(run["agents"], [])
        self.assertEqual(run["counts"], {"valid": 0, "invalid": 0, "ingested": 0})

        run_dir = self.workspace / ".multi-code" / "switchboard" / "watchtower-runs" / run["runId"]
        self.assertTrue((run_dir / "run.json").is_file())
        self.assertFalse((run_dir / "outputs").exists())
        self.assertFalse((run_dir / "quarantine").exists())
        self.assertTrue((run_dir / "reports").is_dir())

        status = stdout_json(self.run_cli(["watchtower", "run-status", *self.workspace_args(), run["runId"]]))
        self.assertEqual(status["run"], run)

        listed = stdout_json(self.run_cli(["watchtower", "run-list", *self.workspace_args()]))
        self.assertEqual([item["runId"] for item in listed["runs"]], [run["runId"]])

    def test_watchtower_run_create_accepts_agents_for_launch_metadata(self) -> None:
        agents = [
            {
                "agentId": "watchtower-code-review",
                "specialistId": "code-review",
                "status": "running",
                "outputDir": "outputs/watchtower-code-review",
                "reportPath": "reports/watchtower-code-review.md",
            }
        ]

        created = stdout_json(
            self.run_cli(
                [
                    "watchtower",
                    "run-create",
                    *self.workspace_args(),
                    "--preset",
                    "lean_code_review",
                    "--status",
                    "running",
                    "--agents-json",
                    json.dumps(agents),
                ]
            )
        )

        self.assertEqual(created["run"]["status"], "running")
        self.assertEqual(created["run"]["agents"], agents)
        run_dir = self.workspace / ".multi-code" / "switchboard" / "watchtower-runs" / created["run"]["runId"]
        self.assertFalse((run_dir / "outputs").exists())
        self.assertTrue((run_dir / "reports").is_dir())

        completed = stdout_json(
            self.run_cli(
                [
                    "watchtower",
                    "run-agent-status",
                    *self.workspace_args(),
                    created["run"]["runId"],
                    "watchtower-code-review",
                    "--status",
                    "completed",
                ]
            )
        )

        self.assertEqual(completed["run"]["status"], "completed")
        self.assertEqual(completed["run"]["agents"][0]["status"], "completed")
        self.assertIsNotNone(completed["run"]["completedAt"])

    def test_watchtower_run_create_rejects_agent_paths_outside_run_directory(self) -> None:
        rejected = self.run_cli(
            [
                "watchtower",
                "run-create",
                *self.workspace_args(),
                "--preset",
                "lean_code_review",
                "--agents-json",
                json.dumps(
                    [
                        {
                            "agentId": "watchtower-code-review",
                            "specialistId": "code-review",
                            "outputDir": "../../outside",
                        }
                    ]
                ),
            ],
            check=False,
        )

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("escapes the run directory", stderr_json(rejected)["message"])

    def test_watchtower_run_status_rejects_invalid_metadata(self) -> None:
        created = stdout_json(
            self.run_cli(["watchtower", "run-create", *self.workspace_args(), "--preset", "lean_code_review"])
        )
        run_id = created["run"]["runId"]
        run_file = self.workspace / ".multi-code" / "switchboard" / "watchtower-runs" / run_id / "run.json"
        payload = json.loads(run_file.read_text(encoding="utf-8"))
        payload["status"] = "mystery"
        run_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

        rejected = self.run_cli(["watchtower", "run-status", *self.workspace_args(), run_id], check=False)

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Watchtower run status is invalid", stderr_json(rejected)["message"])

    def test_watchtower_run_list_reports_invalid_metadata_without_failing(self) -> None:
        valid = stdout_json(
            self.run_cli(["watchtower", "run-create", *self.workspace_args(), "--preset", "lean_code_review"])
        )
        bad_dir = self.workspace / ".multi-code" / "switchboard" / "watchtower-runs" / "watchtower_20260509T120000Z_badbad12"
        bad_dir.mkdir(parents=True)
        (bad_dir / "run.json").write_text("{not json\n", encoding="utf-8")

        listed = stdout_json(self.run_cli(["watchtower", "run-list", *self.workspace_args()]))

        self.assertEqual([run["runId"] for run in listed["runs"]], [valid["run"]["runId"]])
        self.assertEqual(len(listed["problems"]), 1)
        self.assertEqual(listed["problems"][0]["runId"], "watchtower_20260509T120000Z_badbad12")
        self.assertIn("Invalid Watchtower run JSON", listed["problems"][0]["message"])

    def test_create_help_documents_agent_json_schema(self) -> None:
        completed = self.run_cli(["create", "--help"])

        self.assertIn("--input-json", completed.stdout)
        self.assertIn("Agent JSON schema", completed.stdout)
        self.assertIn("Watchtower agents should create findings directly in the inbox", completed.stdout)

    def test_watchtower_agent_can_create_inbox_task_directly(self) -> None:
        created_run = stdout_json(
            self.run_cli(["watchtower", "run-create", *self.workspace_args(), "--preset", "lean_code_review"])
        )
        run_id = created_run["run"]["runId"]
        external_id = f"{run_id}:watchtower-code-review:{uuid.uuid4()}"
        payload = {
            "title": "Direct Watchtower finding",
            "description": "Evidence: switchboard_core/cli.py should expose the task creation schema.",
            "priority": 2,
            "labels": ["watchtower", "Backend"],
            "source": {
                "type": "watchtower",
                "externalId": external_id,
                "externalKey": f"{run_id}:watchtower-code-review",
                "externalUrl": None,
            },
        }

        created_task = stdout_json(
            self.run_cli(["create", *self.workspace_args(), "--inbox", "--input-json", json.dumps(payload)])
        )

        task_id = created_task["id"]
        self.assertEqual(created_task["nextFolder"], "inbox")
        task = json.loads(self.task_file("inbox", task_id).read_text(encoding="utf-8"))
        self.assertEqual(task["title"], payload["title"])
        self.assertEqual(task["labels"], ["watchtower", "backend"])
        self.assertEqual(task["source"], payload["source"])

    def test_watchtower_start_review_launches_runtime_execution(self) -> None:
        command = f"{sys.executable} -c \"import sys; data=sys.stdin.read(); print('watchtower runtime'); print(data[:120])\""
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])

        started = stdout_json(
            self.run_cli(
                ["watchtower", "start-review", *self.workspace_args(), "--preset", "lean_code_review"],
                env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command},
            )
        )

        self.assertTrue(started["ok"])
        run = started["run"]
        self.assertEqual(run["status"], "running")
        self.assertEqual(run["preset"], "lean_code_review")
        running_agents = [agent for agent in run["agents"] if agent["status"] == "running"]
        pending_agents = [agent for agent in run["agents"] if agent["status"] == "pending"]
        self.assertEqual(len(running_agents), 1)
        self.assertGreaterEqual(len(pending_agents), 1)
        execution_id = running_agents[0]["executionId"]
        execution = stdout_json(self.run_cli(["execution", "status", *self.workspace_args(), execution_id]))["execution"]
        self.assertEqual(execution["kind"], "watchtower_review")
        self.assertEqual(execution["watchtowerRunId"], run["runId"])
        self.assertEqual(execution["watchtowerAgentId"], running_agents[0]["agentId"])
        self.assertNotIn("taskId", execution)
        self.assertFalse((self.workspace / ".multi-code" / "switchboard" / "worktrees" / execution_id).exists())

        for _ in range(30):
            status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
            latest = stdout_json(self.run_cli(["watchtower", "run-status", *self.workspace_args(), run["runId"]]))["run"]
            if latest["agents"][0]["status"] == "completed":
                break
            time.sleep(0.1)
        latest = stdout_json(self.run_cli(["watchtower", "run-status", *self.workspace_args(), run["runId"]]))["run"]
        self.assertEqual(latest["agents"][0]["status"], "completed")

    def test_watchtower_start_review_requires_running_runner(self) -> None:
        rejected = self.run_cli(
            ["watchtower", "start-review", *self.workspace_args(), "--preset", "lean_code_review"],
            env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": f"{sys.executable} -c \"pass\""},
            check=False,
        )

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("paused or disabled", stderr_json(rejected)["message"])

    def test_watchtower_start_triage_rejects_while_review_is_active(self) -> None:
        created = self.create_task(inbox=True, title="Triage candidate")
        command = f"{sys.executable} -c \"import time; time.sleep(2)\""
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])

        started = stdout_json(
            self.run_cli(
                ["watchtower", "start-review", *self.workspace_args(), "--preset", "lean_code_review"],
                env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command},
            )
        )
        execution_id = next(agent["executionId"] for agent in started["run"]["agents"] if agent["status"] == "running")

        rejected = self.run_cli(
            ["watchtower", "start-triage", *self.workspace_args(), "--scope", "selected", "--task-id", created["id"]],
            env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command},
            check=False,
        )

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("still running", stderr_json(rejected)["message"])
        self.run_cli(["execution", "stop", *self.workspace_args(), execution_id, "--reason", "test cleanup"], check=False)

    def test_watchtower_start_triage_launches_architect_runtime_execution(self) -> None:
        created = self.create_task(inbox=True, title="Triage candidate")
        task_id = created["id"]
        command = f"{sys.executable} -c \"import sys; data=sys.stdin.read(); print('triage runtime'); print(data[:160])\""
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])

        started = stdout_json(
            self.run_cli(
                ["watchtower", "start-triage", *self.workspace_args(), "--scope", "selected", "--task-id", task_id],
                env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command},
            )
        )

        self.assertTrue(started["ok"])
        run = started["run"]
        self.assertEqual(run["preset"], "inbox_triage")
        agent = run["agents"][0]
        self.assertEqual(agent["specialistId"], "architect")
        self.assertEqual(agent["status"], "running")
        self.assertEqual(agent["taskIds"], [task_id])
        execution = stdout_json(self.run_cli(["execution", "status", *self.workspace_args(), agent["executionId"]]))["execution"]
        self.assertEqual(execution["kind"], "watchtower_triage")
        self.assertEqual(execution["watchtowerRunId"], run["runId"])

    def test_watchtower_triage_failure_persists_agent_error(self) -> None:
        created = self.create_task(inbox=True, title="Failing triage candidate")
        task_id = created["id"]
        command = f"{sys.executable} -c \"import sys; sys.exit(7)\""
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])

        started = stdout_json(
            self.run_cli(
                ["watchtower", "start-triage", *self.workspace_args(), "--scope", "selected", "--task-id", task_id],
                env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command},
            )
        )
        run = started["run"]
        agent = run["agents"][0]

        for _ in range(30):
            self.run_cli(["runner", "status", *self.workspace_args()])
            latest = stdout_json(self.run_cli(["watchtower", "run-status", *self.workspace_args(), run["runId"]]))["run"]
            if latest["agents"][0]["status"] == "failed":
                break
            time.sleep(0.1)

        latest = stdout_json(self.run_cli(["watchtower", "run-status", *self.workspace_args(), run["runId"]]))["run"]
        failed_agent = latest["agents"][0]
        self.assertEqual(latest["status"], "failed")
        self.assertEqual(failed_agent["status"], "failed")
        self.assertEqual(failed_agent["executionId"], agent["executionId"])
        self.assertIn("Process exited with code 7", failed_agent["errorMessage"])

        execution = stdout_json(self.run_cli(["execution", "status", *self.workspace_args(), agent["executionId"]]))["execution"]
        self.assertEqual(execution["kind"], "watchtower_triage")
        self.assertEqual(execution["status"], "abandoned")
        self.assertEqual(execution["exitCode"], 7)

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
        self.assertEqual(commented["record"]["task"]["comments"][-1]["kind"], "comment")

        triaged = stdout_json(
            self.run_cli([
                "comment",
                *self.workspace_args(),
                task_id,
                "--body",
                "Architect triage\n\nRecommendation: Promote\nImportance: High",
                "--author",
                "Architect",
                "--author-type",
                "agent",
                "--author-id",
                "watchtower-architect",
                "--kind",
                "triage",
            ])
        )
        self.assertEqual(triaged["record"]["task"]["comments"][-1]["kind"], "triage")
        self.assertEqual(triaged["record"]["task"]["comments"][-1]["author"]["name"], "Architect")
        self.assertEqual(triaged["record"]["task"]["comments"][-1]["author"]["type"], "agent")
        self.assertEqual(triaged["record"]["task"]["comments"][-1]["author"]["id"], "watchtower-architect")

    def test_import_task_creates_uuid_inbox_task_and_skips_duplicate_source(self) -> None:
        item = {
            "provider": "github",
            "externalId": "I_kwDO123",
            "externalKey": "owner/repo#12",
            "externalUrl": "https://github.com/owner/repo/issues/12",
            "identifier": "repo#12",
            "title": "GitHub issue",
            "description": "Issue body",
            "labels": ["bug", "backend"],
            "priority": None,
            "updatedAt": "2026-05-09T12:00:00Z",
        }

        imported = stdout_json(self.run_cli(["import-task", *self.workspace_args(), "--input-json", json.dumps(item)]))

        self.assertTrue(imported["created"])
        task_id = imported["id"]
        self.assertRegex(task_id, r"^[0-9a-f-]{36}$")
        self.assertNotEqual(task_id, "repo#12")
        task = json.loads(self.task_file("inbox", task_id).read_text(encoding="utf-8"))
        self.assertEqual(task["identifier"], "repo#12")
        self.assertEqual(task["source"]["type"], "github")
        self.assertEqual(task["source"]["externalId"], "I_kwDO123")

        duplicate = stdout_json(self.run_cli(["import-task", *self.workspace_args(), "--input-json", json.dumps(item)]))
        self.assertFalse(duplicate["created"])
        self.assertTrue(duplicate["skipped"])
        inbox = stdout_json(self.run_cli(["list", *self.workspace_args(), "--status", "inbox"]))["tasks"]
        self.assertEqual(len(inbox), 1)

    def test_import_task_uses_url_identity_when_external_id_is_missing(self) -> None:
        first = {
            "provider": "jira",
            "externalUrl": "https://jira.example.test/browse/KEY-123",
            "externalKey": "KEY-123",
            "title": "Jira issue",
        }
        second = {**first, "title": "Changed remote title"}

        created = stdout_json(self.run_cli(["import-task", *self.workspace_args(), "--input-json", json.dumps(first)]))
        duplicate = stdout_json(self.run_cli(["import-task", *self.workspace_args(), "--input-json", json.dumps(second)]))

        self.assertTrue(created["created"])
        self.assertFalse(duplicate["created"])
        task = json.loads(self.task_file("inbox", created["id"]).read_text(encoding="utf-8"))
        self.assertEqual(task["title"], "Jira issue")

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
        execution = claimed["record"]["task"]["execution"]
        self.assertIsNone(execution["worktreePath"])
        self.assertIsNone(execution["worktreeBranch"])
        self.assertIsNone(execution["worktreeState"])
        self.assertIsNone(execution["activeExecutionId"])
        self.assertIsNone(execution["activeProvider"])
        remaining = second if claimed["id"] == first else first
        self.assertTrue(self.task_file("in_progress", claimed["id"]).is_file())
        self.assertTrue(self.task_file("ready", remaining).is_file())

    def test_claim_empty_queue_returns_structured_no_eligible_result(self) -> None:
        payload = stdout_json(self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"]))

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["claimed"])
        self.assertEqual(payload["message"], "No eligible task.")

    def test_requeue_abandoned_in_progress_task(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Requeue task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"])

        requeued = stdout_json(
            self.run_cli(["requeue", *self.workspace_args(), task_id, "--reason", "Agent session stopped."])
        )

        self.assertEqual(requeued["previousFolder"], "in_progress")
        self.assertEqual(requeued["nextFolder"], "ready")
        self.assertIsNone(requeued["record"]["task"]["claim"])
        self.assertIsNone(requeued["record"]["task"]["execution"]["activeExecutionId"])
        self.assertIsNone(requeued["record"]["task"]["execution"]["activeProvider"])
        self.assertIsNone(requeued["record"]["task"]["execution"]["activeSessionId"])
        self.assertIsNone(requeued["record"]["task"]["execution"].get("providerRef"))
        self.assertIn("Agent session stopped.", requeued["record"]["task"]["comments"][-1]["body"])

    def test_publish_rejects_missing_implementation_evidence(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Publish validation task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", "developer-1"])

        rejected = self.run_cli(["publish", *self.workspace_args(), task_id, "--to", "testing"], check=False)

        self.assertNotEqual(rejected.returncode, 0)
        message = stderr_json(rejected)["message"]
        self.assertIn("evidence summary", message)

    def test_publish_to_testing_accepts_valid_implementation_evidence(self) -> None:
        self.init_git_repo()
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
        self.assertIsNone(published["record"]["task"]["claim"])
        self.assertIsNone(published["record"]["task"]["execution"]["activeExecutionId"])
        self.assertIsNone(published["record"]["task"]["execution"]["activeProvider"])
        self.assertIsNone(published["record"]["task"]["execution"]["activeSessionId"])
        self.assertIsNone(published["record"]["task"]["execution"].get("providerRef"))
        self.assertFalse(path.exists())
        self.assertTrue(self.task_file("testing", task_id).is_file())

    def test_publish_to_testing_can_add_evidence_atomically(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Atomic publish evidence task")["id"]
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
        path.write_text(json.dumps(task, indent=2) + "\n", encoding="utf-8")

        published = stdout_json(
            self.run_cli(
                [
                    "publish",
                    *self.workspace_args(),
                    task_id,
                    "--to",
                    "testing",
                    "--summary",
                    "Published with atomic evidence.",
                    "--command",
                    "python -m unittest tests.switchboard_cli.test_cli",
                    "--touched-file",
                    "switchboard_core/store.py",
                    "--artifact",
                    ".multi-code/switchboard/artifacts/report.md",
                    "--comment",
                    "Evidence attached during publish.",
                ]
            )
        )

        self.assertEqual(published["nextFolder"], "testing")
        evidence = published["record"]["task"]["evidence"]
        self.assertEqual(evidence["summary"], "Published with atomic evidence.")
        self.assertIn("python -m unittest tests.switchboard_cli.test_cli", evidence["commandsRun"])
        self.assertIn("switchboard_core/store.py", evidence["touchedFiles"])
        self.assertIn(".multi-code/switchboard/artifacts/report.md", evidence["artifacts"])
        self.assertEqual(published["record"]["task"]["comments"][-2]["body"], "Evidence attached during publish.")

    def test_publish_rejects_wrong_target(self) -> None:
        self.init_git_repo()
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

    def test_concurrent_claim_attempts_claim_one_task_once(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Concurrent claim task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])

        def claim(agent: str) -> subprocess.CompletedProcess[str]:
            return self.run_cli(["claim", *self.workspace_args(), "--from", "ready", "--agent", agent], check=False)

        with ThreadPoolExecutor(max_workers=2) as executor:
            completed = list(executor.map(claim, ["developer-a", "developer-b"]))

        successes = [stdout_json(result) for result in completed if result.returncode == 0 and result.stdout.strip()]
        claimed = [payload for payload in successes if payload.get("claimed") is True]
        empty = [payload for payload in successes if payload.get("claimed") is False]
        lock_failures = [stderr_json(result) for result in completed if result.returncode != 0]

        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0]["id"], task_id)
        self.assertTrue(empty or lock_failures)
        self.assertTrue(self.task_file("in_progress", task_id).is_file())

    def test_create_fails_while_destination_folder_is_locked(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        todo = self.workspace / ".multi-code" / "switchboard" / "tasks" / "todo"
        (todo / ".Lock.lock").mkdir()
        (todo / "Lock").write_text(
            json.dumps(
                {
                    "locked": True,
                    "owner": "other-process",
                    "sessionId": "session-1",
                    "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                    "heartbeatAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        rejected = self.run_cli(["create", *self.workspace_args(), "--title", "Locked create"], check=False)

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Switchboard folder is locked", stderr_json(rejected)["message"])

    def test_read_all_reports_stale_lock_and_recover_lock_clears_it(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        ready = self.workspace / ".multi-code" / "switchboard" / "tasks" / "ready"
        stale_time = (datetime.now(timezone.utc) - timedelta(minutes=10)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        (ready / ".Lock.lock").mkdir()
        (ready / "Lock").write_text(
            json.dumps(
                {
                    "locked": True,
                    "owner": "abandoned-agent",
                    "sessionId": "terminal-1",
                    "createdAt": stale_time,
                    "heartbeatAt": stale_time,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        listed = stdout_json(self.run_cli(["list", *self.workspace_args()]))
        ready_lock = next(lock for lock in listed["locks"] if lock["folderStatus"] == "ready")
        self.assertTrue(ready_lock["locked"])
        self.assertTrue(ready_lock["stale"])
        self.assertEqual(ready_lock["owner"], "abandoned-agent")

        recovered = stdout_json(self.run_cli(["recover-lock", *self.workspace_args(), "--status", "ready"]))
        self.assertTrue(recovered["recovered"])
        self.assertFalse(recovered["lock"]["locked"])
        self.assertFalse((ready / ".Lock.lock").exists())

    def test_concurrent_update_and_move_do_not_duplicate_or_corrupt_task(self) -> None:
        task_id = self.create_task(title="Race task")["id"]

        def update() -> subprocess.CompletedProcess[str]:
            return self.run_cli(["update", *self.workspace_args(), task_id, "--updates-json", json.dumps({"title": "Updated race task"})], check=False)

        def move() -> subprocess.CompletedProcess[str]:
            return self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"], check=False)

        with ThreadPoolExecutor(max_workers=2) as executor:
            completed = list(executor.map(lambda fn: fn(), [update, move]))

        self.assertTrue(any(result.returncode == 0 for result in completed))
        locations = [
            path
            for path in [
                self.task_file("todo", task_id),
                self.task_file("ready", task_id),
            ]
            if path.exists()
        ]
        self.assertEqual(len(locations), 1)
        task = json.loads(locations[0].read_text(encoding="utf-8"))
        self.assertEqual(task["id"], task_id)

    def test_runner_start_status_pause_resume_and_cli_tick_are_durable(self) -> None:
        started = stdout_json(
            self.run_cli(
                [
                    "runner",
                    "start",
                    *self.workspace_args(),
                    "--provider",
                    "local-process",
                    "--cli",
                    "claude",
                    "--queue",
                    "ready",
                    "--max-concurrency",
                    "1",
                ]
            )
        )

        self.assertTrue(started["enabled"])
        self.assertFalse(started["paused"])
        self.assertEqual(started["provider"], "local-process")
        self.assertEqual(started["cli"], "claude")
        self.assertEqual(started["queues"], ["ready"])
        state_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "state.json"
        events_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "events.jsonl"
        self.assertTrue(state_path.is_file())
        self.assertTrue(events_path.is_file())

        noop = f"{sys.executable} -c \"pass\""
        ticked = stdout_json(self.run_cli(["runner", "tick", *self.workspace_args()], env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": noop}))
        self.assertIsNone(ticked["lastError"])
        self.assertEqual(ticked["activeExecutions"], [])

        paused = stdout_json(self.run_cli(["runner", "pause", *self.workspace_args()]))
        self.assertTrue(paused["paused"])
        resumed = stdout_json(self.run_cli(["runner", "resume", *self.workspace_args()]))
        self.assertFalse(resumed["paused"])
        status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
        self.assertTrue(status["enabled"])
        self.assertFalse(status["paused"])

        events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertIn("start", [event["type"] for event in events])
        self.assertIn("tick", [event["type"] for event in events])

    def test_runner_stop_disables_runner_state(self) -> None:
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready"])

        stopped = stdout_json(self.run_cli(["runner", "stop", *self.workspace_args()]))

        self.assertFalse(stopped["enabled"])
        self.assertTrue(stopped["paused"])
        self.assertFalse(stopped["running"])
        status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
        self.assertFalse(status["enabled"])
        self.assertTrue(status["paused"])

    def test_provider_capability_failure_does_not_claim(self) -> None:
        task_id = self.create_task(title="Unsupported provider task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["runner", "start", *self.workspace_args(), "--provider", "codex-app-server", "--queue", "ready"])

        ticked = stdout_json(self.run_cli(["runner", "tick", *self.workspace_args()]))

        self.assertIn("codex-app-server execution provider is defined but not implemented yet", ticked["lastError"])
        self.assertTrue(self.task_file("ready", task_id).is_file())
        self.assertFalse(self.task_file("in_progress", task_id).exists())

    def test_worktree_capability_failure_happens_before_claim(self) -> None:
        task_id = self.create_task(title="Missing git worktree task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        command = f"{sys.executable} -c \"pass\""
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready"])

        ticked = stdout_json(
            self.run_cli(["runner", "tick", *self.workspace_args()], env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command})
        )

        self.assertIn("workspace must be inside a git worktree", ticked["lastError"])
        self.assertTrue(self.task_file("ready", task_id).is_file())
        self.assertFalse(self.task_file("in_progress", task_id).exists())

    def test_runner_tick_claims_and_launches_local_process_with_logs(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Runner local process task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        command = f"{sys.executable} -c \"import sys; print('runner stdout'); print(sys.stdin.read()[:80]); print('runner stderr', file=sys.stderr)\""

        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])
        ticked = stdout_json(
            self.run_cli(["runner", "tick", *self.workspace_args()], env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command})
        )

        self.assertEqual(ticked["provider"], "local-process")
        self.assertEqual(len(ticked["activeExecutions"]), 1)
        execution = ticked["activeExecutions"][0]
        self.assertEqual(execution["taskId"], task_id)
        provider_ref = execution["providerRef"]
        root = self.workspace / ".multi-code" / "switchboard"
        execution_dir = root / provider_ref["executionDir"]
        self.assertTrue((execution_dir / "metadata.json").is_file())
        self.assertTrue((execution_dir / "stdout.log").is_file())
        self.assertTrue((execution_dir / "stderr.log").is_file())
        claimed_task = json.loads(self.task_file("in_progress", task_id).read_text(encoding="utf-8"))
        self.assertEqual(claimed_task["execution"]["activeExecutionId"], execution["executionId"])
        self.assertEqual(claimed_task["execution"]["activeProvider"], "local-process")
        self.assertTrue(Path(claimed_task["execution"]["worktreePath"]).is_dir())
        self.assertEqual(claimed_task["execution"]["worktreeBranch"], execution["worktreeBranch"])
        self.assertEqual(claimed_task["execution"]["worktreeState"], "active")
        self.assertEqual(provider_ref["cwd"], claimed_task["execution"]["worktreePath"])

        execution_status = stdout_json(self.run_cli(["execution", "status", *self.workspace_args(), execution["executionId"]]))
        self.assertEqual(execution_status["execution"]["executionId"], execution["executionId"])
        self.assertEqual(execution_status["execution"]["worktreePath"], claimed_task["execution"]["worktreePath"])
        stdout_tail = None
        for _ in range(30):
            stdout_tail = stdout_json(
                self.run_cli(["execution", "logs", *self.workspace_args(), execution["executionId"], "--stream", "stdout", "--tail", "20"])
            )
            if any("runner stdout" in line for line in stdout_tail["lines"]):
                break
            time.sleep(0.1)
        assert stdout_tail is not None
        self.assertTrue(any("runner stdout" in line for line in stdout_tail["lines"]))
        invalid = self.run_cli(["execution", "status", *self.workspace_args(), "../bad"], check=False)
        self.assertNotEqual(invalid.returncode, 0)

    def test_execution_worktree_cleanup_refuses_dirty_without_force(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Dirty cleanup task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])
        command = f"{sys.executable} -c \"import sys; sys.exit(7)\""

        ticked = stdout_json(
            self.run_cli(["runner", "tick", *self.workspace_args()], env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command})
        )
        execution = ticked["activeExecutions"][0]
        worktree_path = Path(execution["worktreePath"])
        for _ in range(30):
            status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
            if status["activeExecutions"][0].get("status") == "abandoned":
                break
            time.sleep(0.1)

        refused_active_task = self.run_cli(["execution", "cleanup-worktree", *self.workspace_args(), execution["executionId"], "--force"], check=False)

        self.assertNotEqual(refused_active_task.returncode, 0)
        self.assertIn("only allowed for done or canceled tasks", refused_active_task.stderr)
        self.run_cli(["cancel", *self.workspace_args(), task_id, "--reason", "Cleanup abandoned execution."])
        (worktree_path / "dirty.txt").write_text("dirty\n", encoding="utf-8")

        refused = self.run_cli(["execution", "cleanup-worktree", *self.workspace_args(), execution["executionId"]], check=False)

        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("dirty or unmerged", refused.stderr)
        self.assertTrue(worktree_path.exists())

        cleaned = stdout_json(self.run_cli(["execution", "cleanup-worktree", *self.workspace_args(), execution["executionId"], "--force"]))

        self.assertEqual(cleaned["state"], "cleaned")
        self.assertFalse(worktree_path.exists())
        metadata = stdout_json(self.run_cli(["execution", "status", *self.workspace_args(), execution["executionId"]]))["execution"]
        self.assertEqual(metadata["worktreeState"], "cleaned")

    def test_execution_stop_terminates_process_and_marks_task_attempt(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Stop execution task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])
        command = f"{sys.executable} -c \"import time; time.sleep(30)\""
        ticked = stdout_json(
            self.run_cli(["runner", "tick", *self.workspace_args()], env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command})
        )
        execution = ticked["activeExecutions"][0]

        stopped = stdout_json(
            self.run_cli([
                "execution",
                "stop",
                *self.workspace_args(),
                execution["executionId"],
                "--reason",
                "Stopped by test.",
            ])
        )

        self.assertEqual(stopped["status"], "stopped")
        self.assertTrue(stopped["terminated"])
        pid = execution["providerRef"]["pid"]
        for _ in range(30):
            if not process_is_alive(pid):
                break
            time.sleep(0.1)
        self.assertFalse(process_is_alive(pid))
        status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
        self.assertEqual(status["activeExecutions"][0]["status"], "stopped")
        metadata = stdout_json(self.run_cli(["execution", "status", *self.workspace_args(), execution["executionId"]]))["execution"]
        self.assertEqual(metadata["status"], "stopped")
        self.assertEqual(metadata["worktreeState"], "stopped")
        task = json.loads(self.task_file("in_progress", task_id).read_text(encoding="utf-8"))
        self.assertIsNone(task["execution"]["activeExecutionId"])
        self.assertIsNone(task["execution"]["activeProvider"])
        self.assertIsNone(task["execution"]["providerRef"])
        self.assertEqual(task["execution"]["attempts"][0]["summary"], "Stopped by test.")
        self.assertEqual(task["execution"]["attempts"][0]["worktreeState"], "stopped")

    def test_runner_status_reconciles_missing_worktree_after_restart(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Missing worktree reconciliation task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])
        command = f"{sys.executable} -c \"import time; time.sleep(2)\""

        ticked = stdout_json(
            self.run_cli(["runner", "tick", *self.workspace_args()], env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command})
        )
        execution = ticked["activeExecutions"][0]
        worktree_path = Path(execution["worktreePath"])
        subprocess.run(
            ["git", "-C", str(self.workspace), "worktree", "remove", "--force", str(worktree_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )

        status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))

        self.assertEqual(status["activeExecutions"][0]["executionId"], execution["executionId"])
        self.assertEqual(status["activeExecutions"][0]["worktreeState"], "missing")
        metadata = stdout_json(self.run_cli(["execution", "status", *self.workspace_args(), execution["executionId"]]))["execution"]
        self.assertEqual(metadata["worktreeState"], "missing")

    def test_runner_run_writes_server_descriptor_and_serves_health(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        process = subprocess.Popen(
            switchboard_command(["runner", "run", *self.workspace_args()]),
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            descriptor_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "server.json"
            descriptor: dict[str, Any] | None = None
            for _ in range(60):
                if descriptor_path.exists():
                    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
                    break
                if process.poll() is not None:
                    stderr = process.stderr.read() if process.stderr else ""
                    self.fail(f"runner server exited early: {stderr}")
                time.sleep(0.1)
            self.assertIsNotNone(descriptor)
            assert descriptor is not None
            request = urllib.request.Request(
                f"http://{descriptor['host']}:{descriptor['port']}/health",
                headers={"Authorization": f"Bearer {descriptor['token']}"},
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["status"], "healthy")
            self.assertEqual(payload["apiVersion"], 2)
            self.assertEqual(payload["serverPid"], descriptor["pid"])
            self.assertTrue(payload["supervisorRunning"])
            unauthorized = urllib.request.Request(f"http://{descriptor['host']}:{descriptor['port']}/health")
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(unauthorized, timeout=3)
            self.assertEqual(raised.exception.code, 401)
            raised.exception.close()

            duplicate = subprocess.run(
                switchboard_command(["runner", "run", *self.workspace_args()]),
                cwd=REPO_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
                timeout=5,
            )
            self.assertNotEqual(duplicate.returncode, 0)
            self.assertIn("already running", duplicate.stderr)
            self.assertIn("runner-already-running", duplicate.stderr)
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            if process.stderr:
                process.stderr.close()

    def test_runner_stop_endpoint_shuts_down_backend(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        process = subprocess.Popen(
            switchboard_command(["runner", "run", *self.workspace_args()]),
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            descriptor_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "server.json"
            descriptor: dict[str, Any] | None = None
            for _ in range(60):
                if descriptor_path.exists():
                    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
                    break
                if process.poll() is not None:
                    stderr = process.stderr.read() if process.stderr else ""
                    self.fail(f"runner server exited early: {stderr}")
                time.sleep(0.1)
            self.assertIsNotNone(descriptor)
            assert descriptor is not None
            request = urllib.request.Request(
                f"http://{descriptor['host']}:{descriptor['port']}/runner/stop",
                data=b"{}",
                headers={"Authorization": f"Bearer {descriptor['token']}", "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertTrue(payload["ok"])
            self.assertFalse(payload["enabled"])
            process.wait(timeout=5)
            self.assertIsNotNone(process.returncode)
            self.assertFalse(descriptor_path.exists())
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
            if process.stderr:
                process.stderr.close()

    def test_runner_stop_cli_shuts_down_backend(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        process = subprocess.Popen(
            switchboard_command(["runner", "run", *self.workspace_args()]),
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            descriptor_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "server.json"
            for _ in range(60):
                if descriptor_path.exists():
                    break
                if process.poll() is not None:
                    stderr = process.stderr.read() if process.stderr else ""
                    self.fail(f"runner server exited early: {stderr}")
                time.sleep(0.1)
            self.assertTrue(descriptor_path.exists())

            stopped = stdout_json(self.run_cli(["runner", "stop", *self.workspace_args()]))

            self.assertTrue(stopped["ok"])
            self.assertFalse(stopped["enabled"])
            self.assertTrue(stopped["paused"])
            process.wait(timeout=5)
            self.assertIsNotNone(process.returncode)
            self.assertFalse(descriptor_path.exists())
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
            if process.stderr:
                process.stderr.close()

    def test_concurrent_runner_run_allows_only_one_backend(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        processes = [
            subprocess.Popen(
                switchboard_command(["runner", "run", *self.workspace_args()]),
                cwd=REPO_ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(2)
        ]
        try:
            # Wait until exactly one process has exited. With the
            # process-level fcntl/msvcrt singleton in place, one of the
            # two must fail to acquire the lock and exit non-zero; the
            # other keeps serving. Polling descriptor_path is racy
            # because the winner can write the descriptor before the
            # loser's Python interpreter has finished tearing down.
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                exit_codes = [process.poll() for process in processes]
                if sum(code is not None for code in exit_codes) >= 1:
                    break
                time.sleep(0.05)
            running = [process for process in processes if process.poll() is None]
            exited = [process for process in processes if process.poll() is not None]
            self.assertEqual(len(running), 1)
            self.assertEqual(len(exited), 1)
            self.assertNotEqual(exited[0].returncode, 0)
            stderr = exited[0].stderr.read() if exited[0].stderr else ""
            self.assertIn("Switchboard backend", stderr)
            self.assertIn("runner-already-running", stderr)
            self.assertIn(f"\"pid\": {running[0].pid}", stderr)
            descriptor_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "server.json"
            for _ in range(60):
                if descriptor_path.exists():
                    break
                time.sleep(0.1)
            self.assertTrue(descriptor_path.exists())
        finally:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                if process.stderr:
                    process.stderr.close()

    def test_runner_run_can_restart_immediately_after_terminated_backend(self) -> None:
        self.run_cli(["init", *self.workspace_args()])

        def start_backend() -> subprocess.Popen[str]:
            return subprocess.Popen(
                switchboard_command(["runner", "run", *self.workspace_args()]),
                cwd=REPO_ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )

        first = start_backend()
        second: subprocess.Popen[str] | None = None
        try:
            descriptor_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "server.json"
            for _ in range(60):
                if descriptor_path.exists():
                    break
                time.sleep(0.1)
            self.assertTrue(descriptor_path.exists())
            first.terminate()
            first.wait(timeout=3)

            second = start_backend()
            for _ in range(60):
                if second.poll() is not None:
                    stderr = second.stderr.read() if second.stderr else ""
                    self.fail(f"runner backend failed to restart: {stderr}")
                descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
                if descriptor.get("pid") == second.pid:
                    break
                time.sleep(0.1)
            self.assertIsNone(second.poll())
        finally:
            for process in [first, second]:
                if process is None:
                    continue
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                if process.stderr:
                    process.stderr.close()

    def test_health_does_not_wait_for_runner_lock(self) -> None:
        self.run_cli(["init", *self.workspace_args()])
        process = subprocess.Popen(
            switchboard_command(["runner", "run", *self.workspace_args()]),
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            descriptor_path = self.workspace / ".multi-code" / "switchboard" / "runner" / "server.json"
            descriptor: dict[str, Any] | None = None
            for _ in range(60):
                if descriptor_path.exists():
                    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
                    break
                time.sleep(0.1)
            self.assertIsNotNone(descriptor)
            assert descriptor is not None
            lock_dir = self.workspace / ".multi-code" / "switchboard" / "runner" / ".runner.lock"
            lock_dir.mkdir()
            try:
                request = urllib.request.Request(
                    f"http://{descriptor['host']}:{descriptor['port']}/health",
                    headers={"Authorization": f"Bearer {descriptor['token']}"},
                )
                start = time.monotonic()
                with urllib.request.urlopen(request, timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                self.assertLess(time.monotonic() - start, 1.0)
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["apiVersion"], 2)
            finally:
                lock_dir.rmdir()
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            if process.stderr:
                process.stderr.close()

    def test_concurrent_runner_ticks_do_not_exceed_max_concurrency(self) -> None:
        self.init_git_repo()
        first = self.create_task(title="Concurrent runner task 1")["id"]
        second = self.create_task(title="Concurrent runner task 2")["id"]
        self.run_cli(["move", *self.workspace_args(), first, "--to", "ready"])
        self.run_cli(["move", *self.workspace_args(), second, "--to", "ready"])
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])
        command = f"{sys.executable} -c \"import time; time.sleep(2)\""

        def tick() -> subprocess.CompletedProcess[str]:
            return self.run_cli(["runner", "tick", *self.workspace_args()], env={"SWITCHBOARD_LOCAL_PROCESS_COMMAND": command}, check=False)

        with ThreadPoolExecutor(max_workers=2) as executor:
            completed = list(executor.map(lambda _idx: tick(), range(2)))

        self.assertTrue(any(result.returncode == 0 for result in completed))
        status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
        self.assertEqual(len(status["activeExecutions"]), 1)
        in_progress = [path for path in [self.task_file("in_progress", first), self.task_file("in_progress", second)] if path.exists()]
        self.assertEqual(len(in_progress), 1)
        worktrees = list((self.workspace / ".multi-code" / "switchboard" / "worktrees").iterdir())
        self.assertEqual(len([path for path in worktrees if path.is_dir()]), 1)

    def test_runner_run_supervises_and_launches_without_manual_tick(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Supervisor task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])
        command = f"{sys.executable} -c \"import time; time.sleep(2)\""
        process = subprocess.Popen(
            switchboard_command(["runner", "run", *self.workspace_args()]),
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env={**os.environ, "SWITCHBOARD_LOCAL_PROCESS_COMMAND": command, "SWITCHBOARD_RUNNER_INTERVAL_SECONDS": "0.1"},
            text=True,
        )
        try:
            for _ in range(50):
                if self.task_file("in_progress", task_id).exists():
                    break
                if process.poll() is not None:
                    stderr = process.stderr.read() if process.stderr else ""
                    self.fail(f"runner server exited early: {stderr}")
                time.sleep(0.1)
            self.assertTrue(self.task_file("in_progress", task_id).is_file())
            status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
            self.assertEqual(len(status["activeExecutions"]), 1)
            self.assertTrue(Path(status["activeExecutions"][0]["worktreePath"]).is_dir())
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            if process.stderr:
                process.stderr.close()

    def test_runner_run_records_process_exit_as_abandoned(self) -> None:
        self.init_git_repo()
        task_id = self.create_task(title="Exit lifecycle task")["id"]
        self.run_cli(["move", *self.workspace_args(), task_id, "--to", "ready"])
        self.run_cli(["runner", "start", *self.workspace_args(), "--queue", "ready", "--max-concurrency", "1"])
        command = f"{sys.executable} -c \"import sys; sys.exit(7)\""
        process = subprocess.Popen(
            switchboard_command(["runner", "run", *self.workspace_args()]),
            cwd=REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env={**os.environ, "SWITCHBOARD_LOCAL_PROCESS_COMMAND": command, "SWITCHBOARD_RUNNER_INTERVAL_SECONDS": "0.1"},
            text=True,
        )
        try:
            abandoned = None
            for _ in range(60):
                status = stdout_json(self.run_cli(["runner", "status", *self.workspace_args()]))
                executions = status["activeExecutions"]
                if executions and executions[0].get("status") == "abandoned":
                    abandoned = executions[0]
                    break
                time.sleep(0.1)
            self.assertIsNotNone(abandoned)
            assert abandoned is not None
            provider_ref = abandoned["providerRef"]
            root = self.workspace / ".multi-code" / "switchboard"
            metadata = json.loads((root / provider_ref["executionDir"] / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["status"], "abandoned")
            self.assertEqual(metadata["exitCode"], 7)
            self.assertEqual(metadata["worktreeState"], "abandoned")
            self.assertTrue(Path(metadata["worktreePath"]).is_dir())
            self.assertTrue(self.task_file("in_progress", task_id).is_file())
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            if process.stderr:
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
