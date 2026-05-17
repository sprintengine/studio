# Plugin Manifests — Worked Examples

Date: 2026-05-16

Companion to `docs/2026-05-16-byo-cli-plugin-system.md`. The goal here is to validate the manifest design by writing out how it would express real third-party CLIs:

- **Pi** — a new agent harness CLI (specifics to be verified against `pi --help` before any plugin ships)
- **OpenCode** — open-source Claude Code-alike from SST, session model, MCP support
- **Aider** — Python pair-programmer with no session ID concept and file-based chat history, included as a stress test of the schema

These manifests are written against the v1 schema sketched in the design doc. Anything the exercise reveals as missing is called out at the end.

## Caveats

The exact CLI surfaces below are based on each tool's public documentation. The schema is what matters; the specific flags should be verified against `aider --help` and `opencode --help` before any plugin ships. Treat these as design specimens, not paste-ready manifests.

## Example 1: Pi (new agent harness CLI)

Pi is the most interesting test case because it's a recent entrant — the plugin author writing this manifest is doing it from `pi --help` and the project README, not from years of familiarity. The exercise here is to show how the manifest handles the **knowns vs. unknowns** of a new CLI: the manifest is written with explicit placeholders for flags that need to be verified before the plugin ships.

Every line marked `# VERIFY:` is a question the plugin author would answer by reading the CLI's docs or running it locally. The manifest design should make this gap visible rather than hide it.

```yaml
id: pi
displayName: "Pi"
publisher: "community"               # placeholder until official plugin
version: 1
binary: pi                           # VERIFY: is the binary name actually `pi`?

permissionPresets:
  # Most modern agent harnesses ship with at least three modes: prompt-on-every-action,
  # auto-approve-edits-in-workspace, and bypass-everything. Fill in once verified.
  default:
    args: []
    label: "Default"
  auto:
    args: []                         # VERIFY: --auto-approve? --yes? --no-confirm?
    label: "Auto-approve workspace edits"
  bypass:
    args: []                         # VERIFY: --dangerous? --bypass-permissions?
    label: "Bypass all approvals (dangerous)"

launch:
  # VERIFY: does Pi accept a caller-assigned session id? Most new harnesses do.
  # If not, fall back to cwd-based identity like the Aider manifest below.
  command: "{{binary}} {{permissionArgs}} --session {{sessionId}}"
  cwd: "{{workspaceRoot}}"
  env:
    # Pi likely supports multiple providers/models like Codex and OpenCode.
    # The user configures these once in Settings → Plugin → Pi.
    PI_PROVIDER: "{{provider}}"      # VERIFY env var name
    PI_MODEL: "{{model}}"            # VERIFY env var name

resume:
  supported: true                    # VERIFY: does Pi have a resume flag?
  command: "{{binary}} {{permissionArgs}} --session {{sessionId}} --resume"

promptInjection:
  # Sprint Engine prefers REPL + send-after-ready over `pi run "..."`
  # one-shot mode, so a single session can carry across multiple turns.
  mode: send-after-ready
  readiness:
    type: output-match
    pattern: "VERIFY-prompt-pattern" # VERIFY: what does Pi's prompt indicator look like?
    timeoutMs: 15000

completion:
  # Default to output-sentinel because it works regardless of MCP support.
  # If Pi turns out to support MCP, upgrade to mcp-signal with sentinel as fallback.
  mode: output-sentinel
  sentinel: "[sprint-engine:done]"
  fallback:
    mode: idle-at-prompt
    idleMs: 30000
    promptPattern: "VERIFY-prompt-pattern"

mcpConfig:
  # VERIFY: does Pi read MCP server config from a file? If yes, where?
  # If Pi doesn't support MCP, delete this block and use the Aider-style
  # soul that teaches the agent to use `switchboard` CLI directly.
  path: "~/.config/pi/mcp.json"      # VERIFY
  format: generic                    # use the generic adapter until a
                                     # pi-specific format adapter exists

capabilities:
  resumeSession: true                # VERIFY
  sessionIdFromCaller: true          # VERIFY
  toolUse: true                      # VERIFY
  mcpServers: true                   # VERIFY
  imageInput: false                  # VERIFY

variables:
  model:
    type: string
    label: "Model"
    default: ""
    required: true
  provider:
    type: enum
    options: [anthropic, openai, google, ollama]  # VERIFY which providers Pi supports
    default: anthropic
```

The takeaway: a plugin for a new harness can be drafted in 15 minutes by anyone who can read CLI help output. The schema absorbs unknowns as explicit placeholders — Multicode's plugin validator can warn on `VERIFY-prompt-pattern` literals and refuse to enable the plugin until they're filled in. This is how a community plugin ecosystem actually scales: the schema is the contract, not the developer's familiarity with the tool.

If Pi turns out to behave very differently from Claude Code / OpenCode (no session id, no MCP, only one-shot mode), the manifest still expresses it — it just leans on the Aider-style patterns described below.

## Example 2: Aider (Python-based pair-programming CLI)

Aider is interesting because it breaks two assumptions the Claude Code manifest takes for granted:

- **No caller-assignable session ID.** Aider tracks history per-cwd in `.aider.chat.history.md`. The "session" identity is the working directory.
- **No native MCP support.** Aider has its own command surface (`/add`, `/drop`, `/run`, `/test`) but no MCP-server config.

But it fits cleanly with three small accommodations: `sessionIdFromCaller: false`, no `mcpConfig` block, and a `chatHistory` capability declared via cwd uniqueness.

```yaml
id: aider
displayName: "Aider"
publisher: "paul-gauthier"
version: 1
binary: aider                       # installed via `pip install aider-chat`

# Default permission preset is "yes to everything" because the autonomous
# runner spawns Aider in a sandboxed worktree and we don't want to hang
# on confirmations. The user can switch to `default` for interactive use.
permissionPresets:
  default:
    args: []
    label: "Default (asks for confirmation)"
  yes_always:
    args: ["--yes-always", "--no-auto-commits"]
    label: "Auto-approve, manage commits manually"
  yolo:
    args: ["--yes-always", "--auto-commits"]
    label: "Auto-approve and auto-commit"

launch:
  # Aider takes the files to load as positional args. Sprint Engine
  # passes a comma-separated `{{files}}` variable when it knows which
  # files the task touches; otherwise the agent uses `/add` from inside.
  command: "{{binary}} {{permissionArgs}} {{#files}}{{files}}{{/files}}"
  cwd: "{{workspaceRoot}}"
  env:
    # Aider supports many providers. The plugin manifest doesn't
    # hardcode a model; the user sets one via Settings → Plugin → Aider.
    AIDER_MODEL: "{{model}}"

resume:
  # Aider auto-resumes from .aider.chat.history.md in cwd. There's no
  # explicit resume command; "resume" is just "launch again in the
  # same cwd." Sprint Engine takes care of pointing the worktree at
  # the same directory.
  supported: true
  command: "{{binary}} {{permissionArgs}}"

promptInjection:
  # Aider is an interactive REPL. The cleanest mode is to wait for the
  # prompt indicator and send the prompt as keystrokes. Aider also
  # supports `--message "..."` for one-shot non-interactive runs, but
  # that loses conversation history — we want the REPL.
  mode: send-after-ready
  readiness:
    type: output-match
    pattern: "^aider>\\s"
    timeoutMs: 20000

completion:
  # Aider doesn't have an MCP signal. Two viable approaches:
  # 1. Sentinel: the Sprint Engine soul prompt instructs the agent to
  #    print a sentinel line when its turn is done.
  # 2. Idle timeout: if no output for N seconds while the prompt is
  #    showing, assume done.
  # We prefer (1) because it's deterministic.
  mode: output-sentinel
  sentinel: "[sprint-engine:done]"
  fallback:
    mode: idle-at-prompt
    idleMs: 30000
    promptPattern: "^aider>\\s"

# Aider doesn't speak MCP, so no `mcpConfig` block.
# Sprint Engine's MCP tools (task log, comment, publish) are not
# available to an Aider agent. Instead, the soul prompt teaches it
# to run `switchboard` CLI subcommands inside the worktree.

capabilities:
  resumeSession: true               # via cwd, not session id
  sessionIdFromCaller: false        # we tag sessions via the worktree path
  toolUse: true                     # /add, /drop, /run, /test
  mcpServers: false
  imageInput: false
  chatHistoryFile: ".aider.chat.history.md"  # plugin-specific extension
```

The key insight: Sprint Engine's runner doesn't need to know Aider is "different." It hands the plugin a `{{workspaceRoot}}` for the worktree, the plugin's `resume` block uses cwd-based identity, and the soul prompt for Aider is taught to use CLI tools (`switchboard comment`, `git commit`) instead of MCP. The whole adaptation lives inside the plugin + a matching soul. Sprint Engine itself is unchanged.

## Example 3: OpenCode (open-source Claude Code-alike)

OpenCode (`sst-hq/opencode`) is closer in shape to Claude Code — it has sessions, a permission model, MCP server support, and a non-interactive `run` subcommand. It exercises the schema's "happy path."

```yaml
id: opencode
displayName: "OpenCode"
publisher: "sst-hq"
version: 1
binary: opencode

permissionPresets:
  default:
    args: []
    label: "Default (prompts for permissions)"
  auto:
    args: ["--auto-approve", "edit"]
    label: "Auto-approve edits"
  bypass:
    args: ["--auto-approve", "all"]
    label: "Bypass all approvals (dangerous)"

launch:
  # OpenCode's TUI launches as a REPL; it picks up sessions via
  # --session. We assign the executionId as the session id so
  # Sprint Engine can resume the same conversation later.
  command: "{{binary}} {{permissionArgs}} --session {{sessionId}}"
  cwd: "{{workspaceRoot}}"
  env:
    OPENCODE_PROVIDER: "{{provider}}"   # anthropic | openai | google | ...
    OPENCODE_MODEL: "{{model}}"

resume:
  supported: true
  command: "{{binary}} {{permissionArgs}} --session {{sessionId}} --resume"

promptInjection:
  # OpenCode supports both interactive REPL and `opencode run "<prompt>"`
  # for one-shot. Sprint Engine prefers REPL + send-after-ready so the
  # session can carry across multiple turns (handoffs between specialist
  # roles in a sprint).
  mode: send-after-ready
  readiness:
    type: output-match
    pattern: "❯\\s"       # OpenCode's prompt marker
    timeoutMs: 15000

completion:
  # OpenCode has MCP server support, so we use MCP-signal as primary
  # and sentinel as fallback. The Sprint Engine MCP server exposes a
  # `sprintengine.turn.done` tool the agent calls when finished.
  mode: mcp-signal
  signalTool: "sprintengine.turn.done"
  fallback:
    mode: output-sentinel
    sentinel: "[sprint-engine:done]"

mcpConfig:
  # OpenCode reads MCP servers from this file; Multicode writes the
  # Sprint Engine MCP server into it on first launch, scoped to the
  # plugin so we don't stomp the user's other servers.
  path: "~/.config/opencode/mcp.json"
  format: opencode      # known format adapters live in src/main/mcp-config-service.ts

capabilities:
  resumeSession: true
  sessionIdFromCaller: true
  toolUse: true
  mcpServers: true
  imageInput: true
```

## What changes between these three

The same Sprint Engine code drives all three. The plugin manifests express the difference:

| Concern | Pi (unverified) | Aider | OpenCode |
|---|---|---|---|
| Session identity | likely caller-assigned | cwd-based (no `--session`) | caller-assigned via `--session` |
| Resume | likely `--resume` flag | re-launch in same cwd | explicit `--resume` flag |
| Prompt injection | send-after-ready | send-after-ready (`aider>` prompt) | send-after-ready (`❯` prompt) |
| Completion signal | output sentinel (MCP if supported) | output sentinel | MCP signal, sentinel fallback |
| MCP support | unknown | no — use `switchboard` CLI from soul | yes — Sprint Engine MCP server |
| Permission flags | unverified | `--yes-always`, `--auto-commits` | `--auto-approve edit/all` |
| Soul prompt | depends on MCP support | teaches CLI tool use | teaches MCP tool use |

The conductor (Sprint Engine + Switchboard runner) doesn't know any of this. It asks the plugin: "render me a launch command for execution `exec_abc123` in worktree `/tmp/wt_42` with permission preset `bypass`," and the plugin returns:

- Aider → `aider --yes-always --auto-commits` (in cwd `/tmp/wt_42`)
- OpenCode → `opencode --auto-approve all --session exec_abc123` (in cwd `/tmp/wt_42`)

Then the conductor: "wait for ready," "inject prompt," "watch for completion signal." Each plugin's manifest tells it which patterns and signals apply.

## What this exercise revealed about the schema

Three gaps the original design doc didn't fully cover, surfaced by writing real manifests:

1. **Plugin-scoped soul prompts.** Aider needs a different soul than OpenCode because tool-use mechanics differ (CLI subcommands vs MCP). The schema needs a `souls` block — either inline default souls per role, or a `souls/` directory in the plugin folder. The Sprint Engine specialist roster picks the right soul based on `(role, plugin)` tuple.

2. **User-configured plugin variables.** Both manifests reference `{{model}}` and `{{provider}}`. These aren't Sprint Engine concerns; they're user preferences ("I want Aider to use claude-opus-4-7 via Anthropic"). The manifest needs a `variables:` block declaring required and optional inputs, with types and defaults, that the Settings UI renders as form fields. Example:

```yaml
variables:
  model:
    type: string
    label: "Model"
    default: "claude-opus-4-7"
    required: true
  provider:
    type: enum
    options: [anthropic, openai, google, ollama]
    default: anthropic
```

3. **Fallback completion signals.** Both manifests showed a primary + fallback pattern (`mode + fallback`). The original schema only had `mode`. Make `completion` a list or a struct with `primary` and `fallback` keys.

The fixes are small. The schema absorbs both CLIs cleanly once they land. That's the test the design needed to pass.

## So: does Pi fit? Does Aider fit? Does OpenCode fit?

- **Pi:** yes, pending verification of the actual flag surface. The manifest design is deliberately tolerant of "I haven't read the docs yet" — placeholders flow through the validator as warnings rather than parse errors. Once `pi --help` is captured, a community plugin can ship same-day.
- **Aider:** yes, with the addition of `chatHistoryFile` as a capability and a different soul that teaches it CLI tool use instead of MCP. The cwd-as-session-identity model maps naturally onto Sprint Engine's per-task worktree.
- **OpenCode:** yes, on the happy path. It has every concept Sprint Engine wants — session id, MCP, permission presets, REPL. Probably the second plugin Multicode should ship after Claude Code, before even Codex.

The bigger validation from this exercise: **the conductor stays generic.** Plugin authors describe their CLI; nothing in `src/main/terminal-runtime.ts` or `switchboard_core/store.py` needs to change to add a third or fourth or fifth CLI.

That is the moat.
