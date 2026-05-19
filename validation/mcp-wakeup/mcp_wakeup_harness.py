#!/usr/bin/env python3
"""Isolated stdio MCP wake-up feasibility harness."""

from __future__ import annotations

import argparse
import json
import select
import sys
import time
from dataclasses import dataclass
from typing import Any, BinaryIO, TextIO


DEFAULT_NOTIFICATION_METHOD = "sprintengine/dispatch"


@dataclass(frozen=True)
class WakeupConfig:
    delay_ms: int
    notification_method: str
    framing: str
    server_name: str
    trace_path: str | None = None


class TraceLog:
    def __init__(self, path: str | None):
        self.path = path

    def write(self, event: str, payload: dict[str, Any]) -> None:
        if not self.path:
            return
        record = {"event": event, "atMonotonic": time.monotonic(), **payload}
        with open(self.path, "a", encoding="utf-8") as trace_file:
            trace_file.write(json.dumps(record, sort_keys=True) + "\n")


class JsonRpcWriter:
    def __init__(self, output: TextIO | BinaryIO, framing: str):
        self.output = output
        self.framing = framing

    def write(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, separators=(",", ":"))
        if self.framing == "headers":
            encoded = payload.encode("utf-8")
            header = f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii")
            self.output.write(header + encoded)  # type: ignore[arg-type]
        else:
            self.output.write(payload + "\n")  # type: ignore[arg-type]
        self.output.flush()


class JsonRpcLineReader:
    def __init__(self, source: TextIO):
        self.source = source

    def read_message(self, timeout: float | None = None) -> dict[str, Any] | None:
        if timeout is not None and not _stdin_ready(self.source, timeout):
            return None
        line = self.source.readline()
        if not line:
            return None
        return json.loads(line)


class JsonRpcHeaderReader:
    def __init__(self, source: BinaryIO):
        self.source = source

    def read_message(self, timeout: float | None = None) -> dict[str, Any] | None:
        if timeout is not None and not _stdin_ready(self.source, timeout):
            return None
        headers: dict[str, str] = {}
        while True:
            line = self.source.readline()
            if line == b"":
                return None
            stripped = line.strip()
            if not stripped:
                break
            key, _, value = stripped.decode("ascii").partition(":")
            headers[key.lower()] = value.strip()
        length = int(headers.get("content-length", "0"))
        if length <= 0:
            return None
        return json.loads(self.source.read(length).decode("utf-8"))


def _stdin_ready(source: TextIO | BinaryIO, timeout: float) -> bool:
    readable, _, _ = select.select([source], [], [], max(timeout, 0.0))
    return bool(readable)


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def wakeup_notification(config: WakeupConfig) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "method": config.notification_method,
        "params": {
            "kind": "task_ready",
            "source": "mcp-wakeup-harness",
            "message": "Server-originated wake-up notification emitted while the client was idle.",
            "sentAtMonotonic": time.monotonic(),
        },
    }


def handle_request(message: dict[str, Any], config: WakeupConfig) -> dict[str, Any] | None:
    request_id = message.get("id")
    method = message.get("method")
    if request_id is None:
        return None
    if method == "initialize":
        return response(
            request_id,
            {
                "protocolVersion": message.get("params", {}).get("protocolVersion", "2024-11-05"),
                "serverInfo": {"name": config.server_name, "version": "0"},
                "capabilities": {
                    "tools": {},
                    "logging": {},
                    "experimental": {"serverOriginatedNotifications": True},
                },
            },
        )
    if method == "tools/list":
        return response(
            request_id,
            {
                "tools": [
                    {
                        "name": "wakeup_status",
                        "description": "Reports that the wake-up harness is running.",
                        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
                    }
                ]
            },
        )
    if method == "resources/list":
        return response(request_id, {"resources": []})
    if method == "resources/templates/list":
        return response(request_id, {"resourceTemplates": []})
    if method == "prompts/list":
        return response(request_id, {"prompts": []})
    if method == "ping":
        return response(request_id, {})
    if method == "logging/setLevel":
        return response(request_id, {})
    if method == "tools/call" and message.get("params", {}).get("name") == "wakeup_status":
        return response(
            request_id,
            {"content": [{"type": "text", "text": "MCP wake-up harness is running."}], "isError": False},
        )
    return error_response(request_id, -32601, f"Unsupported method: {method}")


def run_server(
    config: WakeupConfig,
    source: TextIO | BinaryIO | None = None,
    output: TextIO | BinaryIO | None = None,
) -> int:
    trace = TraceLog(config.trace_path)
    trace.write("start", {"framing": config.framing, "delayMs": config.delay_ms})
    if config.framing == "headers":
        source = source or sys.stdin.buffer
        output = output or sys.stdout.buffer
        reader = JsonRpcHeaderReader(source)  # type: ignore[arg-type]
    else:
        source = source or sys.stdin
        output = output or sys.stdout
        reader = JsonRpcLineReader(source)  # type: ignore[arg-type]
    writer = JsonRpcWriter(output, config.framing)
    notification_at: float | None = None
    notification_sent = False

    while True:
        now = time.monotonic()
        timeout = None
        if notification_at is not None and not notification_sent:
            timeout = max(notification_at - now, 0.0)
        message = reader.read_message(timeout=timeout)
        if message is None:
            if timeout is None and notification_at is None:
                trace.write("exit", {"reason": "stdin_closed_before_initialize"})
                return 0
            if notification_at is not None and not notification_sent and time.monotonic() >= notification_at:
                notification = wakeup_notification(config)
                writer.write(notification)
                trace.write("send", {"method": notification["method"], "notification": True})
                notification_sent = True
            if notification_sent:
                message = reader.read_message(timeout=None)
                if message is None:
                    trace.write("exit", {"reason": "stdin_closed_after_notification"})
                    return 0
            continue

        trace.write("receive", {"method": message.get("method"), "id": message.get("id")})
        reply = handle_request(message, config)
        if reply is not None:
            writer.write(reply)
            trace.write("send", {"method": message.get("method"), "id": reply.get("id"), "error": "error" in reply})
        if message.get("method") == "initialize" or notification_at is not None:
            notification_at = time.monotonic() + (config.delay_ms / 1000)


def parse_args(argv: list[str] | None = None) -> WakeupConfig:
    parser = argparse.ArgumentParser(description="Isolated MCP stdio wake-up notification harness")
    parser.add_argument("--delay-ms", type=int, default=1500, help="Delay after initialize before emitting notification.")
    parser.add_argument(
        "--notification-method",
        default=DEFAULT_NOTIFICATION_METHOD,
        help="JSON-RPC notification method to emit after the idle delay.",
    )
    parser.add_argument(
        "--framing",
        choices=["headers", "lines"],
        default="headers",
        help="Use MCP Content-Length framing or newline-delimited JSON for local tests.",
    )
    parser.add_argument("--server-name", default="mcp-wakeup-harness")
    parser.add_argument("--trace-path", help="Optional JSONL trace file for target CLI startup diagnosis.")
    args = parser.parse_args(argv)
    if args.delay_ms < 0:
        parser.error("--delay-ms must be non-negative")
    return WakeupConfig(
        delay_ms=args.delay_ms,
        notification_method=args.notification_method,
        framing=args.framing,
        server_name=args.server_name,
        trace_path=args.trace_path,
    )


def main(argv: list[str] | None = None) -> int:
    return run_server(parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
