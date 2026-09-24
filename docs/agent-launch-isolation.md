# Agent launch isolation

What the app writes into a repository when it launches an agent there, which
CLI reads each file, and which of those writes have moved to a mechanism that
reaches only the session the app launched.

Two rules drive everything below.

1. **Nothing of the app's belongs in the repository.** A file the app writes
   into a checkout shows up in `git status`, gets committed by accident, and
   hands a colleague who never ran the app hook commands and absolute paths
   that do not exist on their machine. Anything that genuinely has to live in
   the checkout lives under the one app-owned directory, `.sprintengine/`, and
   ignores itself where it is machine-specific.
2. **The app's hooks, skills and MCP gateway apply to the sessions the app
   launches, never to a CLI run from a plain terminal.** A file in the
   repository fails this by construction: every CLI started in that checkout
   reads it. A launch flag passes it, because the flag exists only on the
   command line the app built.

## The launch-scoped mechanism

For the Claude-family CLIs (Claude Code, and the Z.AI and Kimi providers that
run the same `claude` binary) the app materialises its own plugin once per
build under the profile's userData directory
(`src/main/agent-integration-home.ts`) and passes it at launch:

- `--plugin-dir <userData>/agent-integration/<version>/sprintengine-studio`
  carries the agent-state hook (`hooks/hooks.json` and the reporter beside it),
  the MCP gateway (`.mcp.json`) and the studio skills.
- `--plugin-dir <userData>/agent-integration/<version>/studio-skills` carries
  the workflow skills the app ships (debug, backlog, frontend-design and the
  rest). **New in this change.**
- `--settings '<json>'` carries the status line, which no plugin can declare.

Each is documented by Claude Code as applying to that session only and writing
nothing to disk. The manifests declare them as `launchPlugins` and
`launchSettings`
(`resources/plugins/{claude-code,zai,kimi-claude}/plugin.json`).

A plugin skill is invoked by its bare name (`/debug`) whenever no other command
claims that name, and always as `/studio-skills:debug`, so the invocations the
app already prefills keep resolving. A person's own `.claude/skills/debug`
takes the bare name ahead of the plugin's, which is the precedence they would
expect.

One predicate decides whether a launch carries the plugin:
`launchCarriesAppPlugins(cli, host)` in `src/main/app-services.ts`. On this
machine it is true when the platform takes the flag (not native Windows), the
copy has been materialised, and the CLI's manifest declares `launchPlugins`. On
a WSL machine it is true when the CLI declares `launchPlugins` and that
distribution's helper has written its own copy, with Linux paths substituted
into it (`src/main/hosts/wsl-plugin-copy.ts`). The launch flag, the agent-state
installer and the MCP sync all ask this one question, so none of them can write
a workspace copy of something the launch is also carrying, or skip one it is
not.

## Inventory

Every path the main process writes inside a workspace on behalf of agent
integration, before and after this change. "Launch-scoped" means the CLI
receives the same thing from the command line the app built.

### Written when a workspace is opened

`src/main/studio-plugin-service.ts` → `src/main/skills/studio-plugin.ts`

| Path | What it is for | Read by | Launch-scoped alternative | Now |
|---|---|---|---|---|
| `.sprintengine/studio-plugin/` | Materialised studio plugin (absolute paths substituted in) | Claude Code, via the two settings keys below | `--plugin-dir` | Written only when the launch does **not** carry the plugin; removed otherwise. The other harnesses' skill copies are taken from the bundled template, whose skills carry no tokens. |
| `.claude/settings.local.json` → agent-state hook entries | Agent phase reporting | Claude Code, Z.AI, Kimi Claude | `--plugin-dir` (the plugin's `hooks/hooks.json`) | Removed when the launch carries the plugin (already true before this change); the removal now shares one implementation with the launch-time tidy. |
| `.claude/settings.local.json` → `extraKnownMarketplaces` | Points Claude Code at the workspace plugin copy | Claude Code | `--plugin-dir` | Removed when the launch carries the plugin (already true). |
| `.claude/settings.json` → `enabledPlugins` | Enables the workspace plugin copy | Claude Code | `--plugin-dir` | Removed when the launch carries the plugin (already true). |
| `.sprintengine/hooks/agent-state.mjs` | The reporter the hook entries run | Every command-hook CLI in the workspace | `--plugin-dir` for Claude only | Removed when the launch carries the plugin **and** no other CLI's registration in the workspace still names it. Before this change it was removed unconditionally, which broke a Codex, Cursor or Grok hook in the same checkout. |
| `.claude/skills/studio-*` | Studio skills | Claude Code | `--plugin-dir` | Not copied, and earlier copies with our provenance removed, when the launch carries the plugin (already true). |
| `.agents/skills/studio-*`, `.codex/skills/studio-*`, `.opencode/skills/studio-*`, `.grok/skills/studio-*` | Studio skills | Codex, OpenCode, Grok and any CLI that reads `.agents/skills` | None known; see Remaining | Unchanged. |

The workspace install used to race the materialisation of the launch copy at
startup: a workspace opened in that window was installed the old way — hook,
settings keys, workspace plugin copy — and tidied again moments later. The
service now waits for the copy to settle before it decides (`whenLaunchPluginsSettled`),
so that window writes nothing. A build whose copy failed still installs the old
way, which keeps agent state working.

### Written when an agent is launched

`src/main/terminal-runtime.ts`, spawn path, in the order it runs.

| Path | What it is for | Read by | Launch-scoped alternative | Now |
|---|---|---|---|---|
| `.mcp.json` → `sprintengine-studio` | MCP gateway to the app | Claude Code, Z.AI, Kimi Claude, Grok | `--plugin-dir` (the plugin's `.mcp.json`) for the Claude family | **Not pinned** when the launch carries the plugin, and an entry an earlier launch pinned is removed (only one that runs the bundled bridge; anything else under that id is the repository's and stays). A file left empty is deleted. Servers the person configured for sync are still written: that is their configuration. |
| `.claude/settings.local.json` → `enabledMcpjsonServers` | Pre-approval for the gateway in `.mcp.json` | Claude family | Not needed once the gateway comes from the plugin | Removed with the entry above; the file and `.claude/` are deleted when nothing else is in them. |
| `.codex/config.toml` managed MCP block | MCP gateway | Codex | Possibly `-c mcp_servers.…`; see Remaining | Unchanged. |
| `.cursor/mcp.json`, `opencode.json` | MCP gateway | Cursor, OpenCode | Possibly; see Remaining | Unchanged. |
| `.agents/skills/<id>`, `.claude/skills/<id>`, `.codex/skills/<id>`, … | A bundled skill the prompt invokes (Debug Mode's `debug`, an attached skill, `backlog.work`'s `backlog`) — `builtin-skills.ts` `ensureSkillInstalled` | Each CLI's native skill directory | `--plugin-dir` (`studio-skills`) for the Claude family | **Not copied at all** for a launch that carries the plugin — the call answers `delivered-at-launch` and writes nothing for any harness. For every other CLI the fan-out still runs, but leaves out `.claude/skills` whenever the Claude-family launches carry the plugin, so a Debug Mode Codex launch no longer drops a Claude copy into the repository. Skills a capability module registers live in the module rather than in the plugin, and are copied everywhere as before. |
| `.claude/settings.local.json` → agent-state hooks + status line; `.sprintengine/hooks/agent-state.mjs`; `.sprintengine/hooks/status-line.mjs` | Agent phase and context usage | Claude family | `--plugin-dir` + `--settings` | Not written when the launch carries the plugin (already true). **New:** the launch now also removes what an earlier build wrote, once per workspace per run, so an existing repository is cleaned on the next app-launched session rather than only when the workspace is next opened — which covers worktrees and other launch directories that are never opened as workspaces. |
| `.codex/config.toml` hooks block | Agent phase | Codex | See Remaining | Unchanged. |
| `.cursor/hooks.json` | Agent phase | Cursor | See Remaining | Unchanged. |
| `.grok/hooks/sprintengine-agent-state.json` | Agent phase | Grok | See Remaining | Unchanged. |
| `.opencode/plugin/sprintengine-agent-state.js` | Agent phase | OpenCode | See Remaining | Unchanged. |
| `~/.kimi-code/config.toml` hooks block, `~/.sprintengine/hooks/agent-state.mjs` | Agent phase | Kimi Code | See Remaining | Unchanged. Not in the repository, but it applies to every Kimi Code session on the machine. |
| `.sprintengine/hooks/.gitignore` | Keeps the reporter copies out of `git status` | git | — | **New.** Written once (never over an existing file) wherever the app still copies a reporter into a workspace, the same self-ignore the backlog cache and browser captures already use. Removed with the directory when the last registration goes. |
| `<git dir>/info/exclude` | Keeps `.mcp.json` / `.codex/config.toml` out of a connector worktree's git | git | — | Unchanged (connector launches only). |

Nothing else the launch produces touches the repository. The host-context
document every launch writes (and the one-session plugin directory Cursor
receives it in) lives under `<userData>/host-context/`, and is removed when the
session ends.

### Not agent integration

The app's own features keep their state under `.sprintengine/` already:
worktrees, automations, the backlog link cache, browser captures, conversation
records, module storage and phone uploads. The caches ignore themselves. None
of it is read by an agent CLI's configuration loader, so none of it carries the
app's behaviour into a plain-terminal session.

Writes a person asks for explicitly — installing a skill or plugin from the
catalogue, attaching a skill to an agent, attaching a design system, syncing
skills — land where the person asked. They are left alone here: they are a
choice, not pollution.

## What this change does, in short

- The Claude-family launch carries the `studio-skills` plugin directory, and the
  skill installer writes nothing for a launch that carries it — nor
  `.claude/skills` for another CLI's launch while it does.
- The Claude-family launch takes the MCP gateway from the plugin, not from the
  repository's `.mcp.json`, and removes the entry and approval an earlier launch
  wrote. The agent CLI now travels in the session environment
  (`SPRINTENGINE_AGENT_CLI`) so the gateway can still attribute the connection.
- The launch-time agent-state installer tidies a stale Claude registration
  instead of silently skipping it.
- The shared reporter under `.sprintengine/hooks` is only removed when no other
  CLI's registration in the workspace still names it.
- The workspace plugin copy under `.sprintengine/studio-plugin` is not written,
  and is removed, when the launch carries the plugin.
- The workspace install waits for the launch copy before deciding, so startup no
  longer writes the old arrangement for a moment.
- `.sprintengine/hooks` ignores itself where the app still writes it.

A Claude Code session the app launches on macOS or Linux therefore leaves no
file in the repository, and a `claude` started from a plain terminal in the same
checkout sees none of the app's hooks, skills or MCP server.

## Remaining

Each of these still writes into the repository (or the home directory) because
the CLI has no launch-scoped route the code can rely on today. Nothing below was
changed; each entry says what the CLI would need to offer, or what has to be
measured first.

- **Codex.** Hooks go into `.codex/config.toml`, the gateway into the same file,
  and skills into `.codex/skills` and `.agents/skills`. Codex already takes
  `-c key=value` overrides at launch (the app passes `developer_instructions`
  that way), so the gateway could plausibly move to `-c mcp_servers.<id>.…` and
  the hooks to a `-c hooks…` override. Neither has been measured against the
  interactive CLI, and a silent failure there would cost the session its agent
  state, so the move waits on that measurement. `CODEX_HOME` would isolate
  everything but relocates the whole profile, credentials included, so it is not
  a route. Skills need a launch-time skill directory, which Codex does not offer.
- **Cursor.** Hooks go into `.cursor/hooks.json` and the gateway into
  `.cursor/mcp.json`. Cursor's CLI already takes `--plugin-dir` (the app packs
  the host-context document as a one-session Cursor plugin), so if a Cursor
  plugin can declare hooks and MCP servers, both could move into that same
  directory. That needs measuring against the CLI before it can be relied on.
- **OpenCode.** The agent-state plugin goes into `.opencode/plugin/`, the gateway
  into `opencode.json` and skills into `.opencode/skills`. OpenCode already reads
  `OPENCODE_CONFIG_CONTENT` from the launch environment (the app passes its
  instructions that way); if that inline config honours `plugin` and `mcp`
  entries, both could move there. Skills would need a configurable skill path.
- **Grok.** Hooks go into `.grok/hooks/`, the gateway into `.mcp.json`, skills
  into `.grok/skills`. Its manifest declares no plugin-directory, settings or
  config-override flag; it would need one. Grok reads the same `.mcp.json` the
  Claude family used to, so a Grok launch pins the gateway there again and the
  next app-launched Claude session takes it back out; neither session is
  affected, because each CLI reads the file as it starts.
- **Kimi Code.** Its only registration is user-scoped
  (`~/.kimi-code/config.toml`), so it applies to every Kimi Code session on the
  machine. It would need a launch-time config file or override.
- **Gemini.** No manifest ships under `resources/plugins`, so the app writes
  nothing for it.
- **Native Windows.** Claude-family launches there still use the workspace
  install (and the gateway and skill copies). A WSL machine does not: its helper
  holds a copy of its own inside the distribution.
- **Bundled skills in WSL.** The skill installer does not yet ask which machine
  a launch is on, so a Debug Mode or skill-at-spawn launch in WSL still copies
  the skill into `.claude/skills` beside the plugin's own.
- **Chat mode.** The conversation runtime (the Agent SDK provider) still pins
  the gateway into `.mcp.json` before a chat. The SDK takes MCP servers and
  plugins as options, so this can move to a launch-scoped route without a CLI
  change; it has not been done here.
- **Skills a capability module registers** are copied into each CLI's native
  directory for every CLI, Claude included, because they live in the module's
  tree rather than in the `studio-skills` plugin.
- **Copies an earlier build left in `.claude/skills`.** A bundled skill copied
  there by an earlier launch carries the same managed manifest as one copied
  when a person imports an existing agent configuration, so the two cannot be
  told apart and neither is deleted. It still works, and takes the bare
  invocation name ahead of the plugin's; deleting the directory by hand is safe.
