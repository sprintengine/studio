from __future__ import annotations

import json
import subprocess
import sys


def run_souls(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "souls", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_souls_list_includes_canonical_roles() -> None:
    completed = run_souls("list", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    roles = {soul["role"] for soul in payload["souls"]}

    assert payload["ok"] is True
    assert {
        "architect",
        "coordinator",
        "product",
        "developer",
        "devops",
        "frontend",
        "tester",
        "security",
        "code_reviewer",
        "performance",
    }.issubset(roles)


def test_souls_get_returns_prompt_for_alias() -> None:
    completed = run_souls("get", "qa-test", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "tester"
    assert "principal QA engineer" in payload["content"]


def test_souls_get_returns_multiloop_coordinator() -> None:
    completed = run_souls("get", "multiloop-coordinator", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "coordinator"
    assert "principal-level coordination agent" in payload["content"]
    assert "Multiloop" not in payload["content"]
    assert "{{final_goal}}" not in payload["content"]


def test_souls_validate_passes() -> None:
    completed = run_souls("validate")

    assert completed.returncode == 0, completed.stderr
    assert "All Souls are valid." in completed.stdout


def test_souls_unknown_role_fails_clearly() -> None:
    completed = run_souls("get", "unknown-role", "--format", "json")

    assert completed.returncode == 1
    payload = json.loads(completed.stderr)
    assert payload["ok"] is False
    assert payload["error"] == "soul_not_found"
    assert "Unknown Soul role" in payload["message"]
