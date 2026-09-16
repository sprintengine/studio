"""The self-hosting wedge: a freshly started engine process still runs a sprint.

Every other suite in this directory drives `SprintEngineMcpServer` in-process, so
it proves the engine's logic but not that the engine still *starts* and still
speaks its protocol. This repository runs its own sprints on the engine it is
editing, so a change that lands cleanly in-process and then fails at startup —
an import that only resolves under pytest, a tool the server can no longer
advertise, a composed prompt that no longer renders — takes the sprint that
would have caught it down with it.

So this spawns `python -m sprintengine_mcp` the way the app's MCP hub does and
drives a whole sprint through it over stdio JSON-RPC: initialize, create a run,
join two roles, walk the plan-approval gate, claim, publish, self-review, and
land the run in `completed`.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# A wedged engine must fail this test, not hang the suite: nothing configures a
# global pytest timeout, so a bare blocking read on the child's stdout would
# stall every later suite behind it.
REPLY_TIMEOUT_SECONDS = 60
SHUTDOWN_TIMEOUT_SECONDS = 30

# Prose the coordination layer contributes to every composed role prompt. A join
# that returned a bare Soul, or no prompt at all, would still be "ok".
COORDINATION_MARKERS = (
    "# SprintEngine Coordination Rules",
    "You Own Your Task From Claim To Done",
    "sprintengine.task.publish",
    "# Commit Scope",
    "Escalate Only What You Must Not Invent",
)


class RestartedEngine:
    """A `python -m sprintengine_mcp` subprocess speaking line-delimited JSON-RPC."""

    def __init__(self, allowed_root: Path) -> None:
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(REPO_ROOT), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
        )
        env["SPRINTENGINE_MCP_USER_ID"] = "smoke-operator"
        env["SPRINTENGINE_MCP_USER_AUTHORIZED"] = "1"
        self._proc = subprocess.Popen(
            [sys.executable, "-m", "sprintengine_mcp", "--allowed-root", str(allowed_root)],
            cwd=str(REPO_ROOT),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        # `None` marks end-of-stream, so a closed transport surfaces as a failed
        # read rather than as a timeout.
        self._replies: queue.Queue[str | None] = queue.Queue()
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self) -> None:
        assert self._proc.stdout
        for line in self._proc.stdout:
            if line.strip():
                self._replies.put(line)
        self._replies.put(None)

    def rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._next_id += 1
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": self._next_id, "method": method}
        if params is not None:
            message["params"] = params
        assert self._proc.stdin
        self._proc.stdin.write(json.dumps(message) + "\n")
        self._proc.stdin.flush()
        try:
            line = self._replies.get(timeout=REPLY_TIMEOUT_SECONDS)
        except queue.Empty:
            raise AssertionError(
                f"the engine did not answer {method} within {REPLY_TIMEOUT_SECONDS}s"
            ) from None
        if line is None:
            stderr = self._proc.stderr.read() if self._proc.stderr else ""
            raise AssertionError(f"the engine closed the transport. stderr:\n{stderr}")
        return json.loads(line)

    def call(self, name: str, **arguments: Any) -> dict[str, Any]:
        reply = self.rpc("tools/call", {"name": name, "arguments": arguments})
        assert "result" in reply, f"{name} -> {json.dumps(reply)[:600]}"
        payload = json.loads(reply["result"]["content"][0]["text"])
        assert payload.get("ok") is True, f"{name} failed: {json.dumps(payload)[:600]}"
        return payload["result"]

    def close(self) -> None:
        if self._proc.stdin:
            self._proc.stdin.close()
        try:
            self._proc.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()


@pytest.fixture
def engine(tmp_path: Path):
    started = RestartedEngine(tmp_path)
    try:
        yield started
    finally:
        started.close()


@pytest.fixture
def project(tmp_path: Path) -> Path:
    repo = tmp_path / "project"
    repo.mkdir()
    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "smoke@example.com"],
        ["git", "config", "user.name", "Smoke"],
    ):
        subprocess.run(command, cwd=repo, check=True)
    (repo / "README.md").write_text("# smoke\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=repo, check=True)
    return repo


def test_a_restarted_engine_advertises_its_tools(engine: RestartedEngine) -> None:
    initialized = engine.rpc("initialize", {"protocolVersion": "2024-11-05"})

    assert initialized["result"]["serverInfo"]["name"] == "sprintengine-mcp"

    names = {tool["name"] for tool in engine.rpc("tools/list")["result"]["tools"]}
    assert {
        "sprintengine.agent.join",
        "sprintengine.task.next",
        "sprintengine.task.publish",
        "sprintengine.task.advance",
    } <= names


def test_a_restarted_engine_runs_a_sprint_from_creation_to_completion(
    engine: RestartedEngine, project: Path
) -> None:
    state_path = project / ".sprintengine" / "sprintengine" / "smoke" / "run.yaml"
    state_path.parent.mkdir(parents=True)
    engine.rpc("initialize", {"protocolVersion": "2024-11-05"})

    engine.call(
        "sprintengine.init", statePath=str(state_path),
        goal="Restarted-engine smoke", agent=["architect:1", "developer:1"],
    )

    # Join: the composed prompt, not just an ok envelope.
    for role in ("architect", "developer"):
        joined = engine.call(
            "sprintengine.agent.join", statePath=str(state_path),
            role=role, agentId=f"{role}-1",
        )
        prompt = joined.get("prompt") or ""
        for marker in COORDINATION_MARKERS:
            assert marker in prompt, f"{role} join prompt is missing {marker!r}"
        assert joined["roleManifest"]["id"] == role

    # The architect claims the plan-approval gate and plans the work.
    gate = engine.call(
        "sprintengine.task.next", statePath=str(state_path), role="architect", id="architect-1"
    )
    assert gate["claimed"] is True
    gate_task_id = gate["task"]["id"]

    planned = engine.call(
        "sprintengine.plan.add_task", statePath=str(state_path), id="architect-1",
        role="developer", title="Smoke: touch a file",
        description="Write one line so publish sees a diff.",
        acceptance=["notes.md exists."], path=["notes.md"],
    )
    task_id = planned["taskId"]

    (state_path.parent / "plan.md").write_text("# Smoke Plan\n", encoding="utf-8")
    artifact_id = engine.call("sprintengine.artifact.list", statePath=str(state_path))[
        "artifacts"
    ][0]["id"]
    engine.call(
        "sprintengine.artifact.ready", statePath=str(state_path),
        artifactId=artifact_id, id="architect-1",
    )
    engine.call(
        "sprintengine.artifact.approve", statePath=str(state_path),
        artifactId=artifact_id, id="architect-1",
    )
    assert engine.call(
        "sprintengine.task.get", statePath=str(state_path), taskId=gate_task_id
    )["task"]["status"] == "done"

    # Approving the plan is what makes the planned work claimable.
    claimed = engine.call(
        "sprintengine.task.next", statePath=str(state_path), role="developer", id="developer-1"
    )
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == task_id

    (project / "notes.md").write_text("smoke\n", encoding="utf-8")
    published = engine.call(
        "sprintengine.task.publish", statePath=str(state_path),
        taskId=task_id, id="developer-1", summary="Wrote notes.md.", path=["notes.md"],
    )
    assert published["nextStatus"] == "review"  # a diff routes into the review phase

    advanced = engine.call(
        "sprintengine.task.advance", statePath=str(state_path),
        taskId=task_id, id="developer-1", phase="review", outcome="pass",
        summary="Self-reviewed the one-line change; nothing to fix.",
    )
    assert advanced["nextStatus"] == "done"

    summary = engine.call("sprintengine.summary", statePath=str(state_path))["summary"]
    assert summary["status"] == "completed"
    assert summary["tasks"] == {"completed": 2, "remaining": 0, "total": 2}
    assert engine.call("sprintengine.run.get", statePath=str(state_path))["run"][
        "status"
    ] == "completed"
