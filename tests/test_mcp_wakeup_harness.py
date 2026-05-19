from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HARNESS = REPO_ROOT / "validation" / "mcp-wakeup" / "mcp_wakeup_harness.py"


def framed(message: dict[str, object]) -> bytes:
    payload = json.dumps(message, separators=(",", ":"))
    encoded = payload.encode("utf-8")
    return f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii") + encoded


def parse_framed_messages(output: bytes) -> list[dict[str, object]]:
    messages: list[dict[str, object]] = []
    cursor = 0
    while cursor < len(output):
        header_end = output.find(b"\r\n\r\n", cursor)
        if header_end == -1:
            break
        headers = output[cursor:header_end].decode("ascii").split("\r\n")
        length = 0
        for header in headers:
            key, _, value = header.partition(":")
            if key.lower() == "content-length":
                length = int(value.strip())
        start = header_end + 4
        end = start + length
        messages.append(json.loads(output[start:end].decode("utf-8")))
        cursor = end
    return messages


def test_line_framed_harness_emits_delayed_server_notification() -> None:
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "clientInfo": {"name": "pytest", "version": "0"}},
    }

    completed = subprocess.run(
        [sys.executable, str(HARNESS), "--framing", "lines", "--delay-ms", "10"],
        cwd=REPO_ROOT,
        input=json.dumps(initialize) + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=5,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    messages = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert messages[0]["id"] == 1
    assert messages[0]["result"]["serverInfo"]["name"] == "mcp-wakeup-harness"
    assert messages[0]["result"]["capabilities"]["experimental"]["serverOriginatedNotifications"] is True
    assert messages[1]["method"] == "sprintengine/dispatch"
    assert messages[1]["params"]["kind"] == "task_ready"
    assert messages[1]["params"]["source"] == "mcp-wakeup-harness"


def test_header_framed_harness_handles_common_startup_probes_before_notification() -> None:
    messages = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "clientInfo": {"name": "pytest", "version": "0"}},
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "resources/list", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "prompts/list", "params": {}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}},
        {"jsonrpc": "2.0", "id": 5, "method": "ping", "params": {}},
        {"jsonrpc": "2.0", "id": 6, "method": "resources/templates/list", "params": {}},
    ]

    completed = subprocess.run(
        [sys.executable, str(HARNESS), "--delay-ms", "10"],
        cwd=REPO_ROOT,
        input=b"".join(framed(message) for message in messages),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=5,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    responses = parse_framed_messages(completed.stdout)
    assert [message.get("id") for message in responses[:6]] == [1, 2, 3, 4, 5, 6]
    assert responses[1]["result"] == {"resources": []}
    assert responses[2]["result"] == {"prompts": []}
    assert responses[3]["result"]["tools"][0]["name"] == "wakeup_status"
    assert responses[4]["result"] == {}
    assert responses[5]["result"] == {"resourceTemplates": []}
    assert responses[6]["method"] == "sprintengine/dispatch"


def test_harness_reports_unsupported_methods_as_json_rpc_errors() -> None:
    request = {"jsonrpc": "2.0", "id": 7, "method": "unknown/method", "params": {}}

    completed = subprocess.run(
        [sys.executable, str(HARNESS), "--framing", "lines", "--delay-ms", "0"],
        cwd=REPO_ROOT,
        input=json.dumps(request) + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=5,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    message = json.loads(completed.stdout)
    assert message["id"] == 7
    assert message["error"]["code"] == -32601
