# MCP Wake-Up Compatibility Notes

Date: 2026-05-19

These notes diagnose target CLI startup behavior against the isolated wake-up harness. They do not prove model-session wake behavior.

## Harness Adjustments

- Header-framed stdio now uses byte streams for MCP `Content-Length` messages.
- Startup probes for `resources/list`, `resources/templates/list`, `prompts/list`, `tools/list`, `ping`, and `logging/setLevel` return empty successful responses where appropriate.
- The delayed `sprintengine/dispatch` notification is scheduled after the latest received startup message, so it is emitted after the client reaches an idle waiting state instead of racing the initial handshake.
- `--trace-path` records minimal JSONL startup evidence with event names, request methods, and response ids. It intentionally omits payload bodies.

## Codex 0.130.0

Commands used:

```bash
codex mcp add mcp-wakeup-harness -- "$PWD/.venv/bin/python" "$PWD/validation/mcp-wakeup/mcp_wakeup_harness.py" --delay-ms 1500 --trace-path "$PWD/validation/mcp-wakeup/codex-startup-trace.jsonl"
codex exec -C . --sandbox workspace-write "Use the MCP server named mcp-wakeup-harness. Do not answer immediately. Wait silently until the server sends a server-originated sprintengine/dispatch notification, then report whether this model session resumed without terminal input and include any observed notification details."
codex mcp remove mcp-wakeup-harness
```

Observed behavior:

- Codex launched the configured harness process.
- Codex reported `MCP startup failed: timed out handshaking with MCP server after 30s`.
- The trace file recorded only `start`; no `initialize` request reached the harness before Codex timed out.
- Retesting with resolved executable and script paths did not change the timeout.

Compatibility conclusion:

Codex startup remains blocked before the MCP protocol handshake. The precise blocker is that Codex starts the stdio process but does not deliver an `initialize` message to this harness before its 30-second startup timeout. This is still `inconclusive` for wake behavior; no `sprintengine/dispatch` notification can be observed until Codex completes startup.

## Claude Code 2.1.144

Commands used:

```bash
claude mcp add --scope project mcp-wakeup-harness -- "$PWD/.venv/bin/python" "$PWD/validation/mcp-wakeup/mcp_wakeup_harness.py" --delay-ms 1500 --trace-path "$PWD/validation/mcp-wakeup/claude-startup-trace.jsonl"
claude mcp get mcp-wakeup-harness
claude mcp remove mcp-wakeup-harness -s project
```

Observed behavior:

- Claude Code launched the configured harness process.
- `claude mcp get mcp-wakeup-harness` reported `Failed to connect`.
- The trace file recorded `start`, then `exit` with `stdin_closed_before_initialize`.
- No `initialize` request reached the harness before Claude Code closed stdin.

Compatibility conclusion:

Claude Code health-check startup remains blocked before the MCP protocol handshake. The precise blocker is that Claude Code starts the stdio process, closes stdin without sending `initialize`, and reports a failed connection. This is still `inconclusive` for wake behavior through `claude mcp get`. A separate noninteractive Claude run with a strict MCP config did not surface the delayed custom notification as a model wake event.
