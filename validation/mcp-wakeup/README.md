# MCP Wake-Up Harness

This directory contains an isolated feasibility harness for Sprint Engine MCP wake-up validation. It does not change production Sprint Engine runtime paths.

The harness starts a local stdio JSON-RPC server, responds to `initialize`, then emits a delayed server-originated notification after the client is expected to be idle. The default notification method is `sprintengine/dispatch`.

## Local Smoke Test

Run the harness directly:

```bash
scripts/mcp-wakeup-harness --delay-ms 1500
```

For deterministic local tests without MCP `Content-Length` framing:

```bash
.venv/bin/python validation/mcp-wakeup/mcp_wakeup_harness.py --framing lines --delay-ms 50
```

Send this initialize message on stdin when using `--framing lines`:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"manual","version":"0"}}}
```

Expected output is an initialize response followed by a server-originated notification whose `method` is `sprintengine/dispatch`.

For startup diagnostics, add `--trace-path validation/mcp-wakeup/<target>-startup-trace.jsonl`. The trace records process start, request methods received, response ids sent, and whether stdin closed before initialization.


## Codex Target

Capture the installed version:

```bash
codex --version
```

Register a temporary stdio MCP server that runs the harness from the repository root:

```bash
codex mcp add mcp-wakeup-harness -- .venv/bin/python validation/mcp-wakeup/mcp_wakeup_harness.py --delay-ms 1500
codex mcp get mcp-wakeup-harness
codex -C . "Connect to the mcp-wakeup-harness MCP server, then wait silently for a server-originated notification. Report whether the model session resumed without terminal input."
```

Remove the temporary server after validation:

```bash
codex mcp remove mcp-wakeup-harness
```

Record the Codex version, the exact MCP configuration used, whether the notification reached the protocol logs if visible, and whether the model session responded without additional terminal input.

## Claude Code Target

Capture the installed version:

```bash
claude --version
```

Register a temporary project stdio MCP server:

```bash
claude mcp add --scope project mcp-wakeup-harness -- .venv/bin/python validation/mcp-wakeup/mcp_wakeup_harness.py --delay-ms 1500
claude mcp get mcp-wakeup-harness
claude --strict-mcp-config --mcp-config .mcp.json "Connect to the mcp-wakeup-harness MCP server, then wait silently for a server-originated notification. Report whether the model session resumed without terminal input."
```

Remove the temporary server after validation:

```bash
claude mcp remove mcp-wakeup-harness
```

Record the Claude Code version, the configuration path or command used, protocol/log visibility, and whether terminal input was required.

## BYO-CLI Target

Current Multicode plugin fixtures identify `opencode` and `pi` as BYO-CLI targets with MCP server support. `aider` is present as a fixture but declares `mcpServers: false`, so classify it `unsupported` for this harness unless a newer real local Aider configuration proves otherwise.

Check availability first:

```bash
command -v opencode || true
command -v pi || true
command -v aider || true
```

For `opencode`, use its configured MCP path from the fixture, `~/.config/opencode/mcp.json`, and add a temporary server entry equivalent to:

```json
{
  "mcpServers": {
    "mcp-wakeup-harness": {
      "type": "stdio",
      "command": ".venv/bin/python",
      "args": ["validation/mcp-wakeup/mcp_wakeup_harness.py", "--delay-ms", "1500"]
    }
  }
}
```

For `pi`, use its configured MCP path from the fixture, `~/.config/pi/mcp.json`, and add the same generic `mcpServers` entry. Then launch the target CLI from the repository root with its normal Multicode/plugin command and ask it to connect to `mcp-wakeup-harness` and wait silently for the delayed server notification.

If the target binary is unavailable or cannot connect to a local stdio MCP server, record the failure as `inconclusive` with the install, configuration, or protocol blocker. Do not classify wake-up support from mocked CLI behavior.

## Result Classifications

Use one of these classifications in validation evidence:

- `direct_mcp_wake`: the model session resumed from the server-originated notification without terminal input.
- `terminal_input_required`: protocol notification was sent or observed, but the model session only resumed after terminal input.
- `unsupported`: the target CLI does not support the required stdio MCP server pattern.
- `inconclusive`: the target could not be tested; include a concrete blocker and reproduction notes.
