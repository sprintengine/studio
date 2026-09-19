// `${CLAUDE_PLUGIN_ROOT}`: the one variable a plugin's own declarations may use
// to reach the plugin's own files
// (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
//
// Claude Code's plugin loader defines it, and nothing else does — not the
// shell, not this app, not the CLI reading `.mcp.json`. So a server declared
// like telegram's,
//
//     bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start
//
// lands in the workspace's MCP config perfectly and can never start: the
// argument expands to nothing, `bun` runs in whatever directory the CLI was
// in, and there is no package.json there. The fix is on both sides — the
// plugin's files are copied into the workspace (src/main/skills/plugin-directory.ts)
// and the variable is replaced here with where they landed.
//
// What the official repository actually uses, read at
// `anthropics/claude-plugins-official` 85cce0381e7860082641b59d961a2b8c368b8b79
// on 2026-09-06 (fifteen `.mcp.json`, checked against the live head):
//
//   - Four servers use `${CLAUDE_PLUGIN_ROOT}` and nothing else does:
//     telegram, discord, imessage, fakechat, all four the same `bun run --cwd`
//     line. That is this module's whole job.
//   - `${CONTEXT7_API_KEY:-}`, `${GITHUB_PERSONAL_ACCESS_TOKEN}`, `${TFE_TOKEN}`
//     are the person's secrets, in headers and env. They are named, never
//     valued, and stay exactly as they are — `envVarNames` already collects
//     them and the surfaces already ask for them.
//   - `npx`, `uvx`, `php`, `docker` are runtimes looked up on PATH, and
//     `php artisan boost:mcp` is relative to the PROJECT, not the plugin.
//     Nothing here rewrites those; a command the machine does not have is
//     reported as the honest state it is, not resolved into a guess.
//   - No relative command paths (`./server`, `bin/x`) exist in that repository.
//     One would not be rewritten either: the OS resolves a relative command
//     against the working directory, and pretending it means "inside the
//     plugin" would launch a file the publisher did not name. It fails the
//     PATH probe like any other missing command, and is reported that way.
//
// Pure and node-free: main installs with it, main's sync re-applies it, and the
// renderer asks the same question to decide whether a server can be added on
// its own at all.

import type { ScannedMcpServer } from '../skills'

/** The variable Claude Code's plugin loader sets to the plugin's directory. */
export const PLUGIN_ROOT_VARIABLE = 'CLAUDE_PLUGIN_ROOT'

/**
 * Every spelling a shell — or Claude Code's own expander — would accept:
 * `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT:-fallback}` and the bare
 * `$CLAUDE_PLUGIN_ROOT`. The bare form is anchored so `$CLAUDE_PLUGIN_ROOTS`
 * is left alone: that is a different variable, not this one with a suffix.
 */
const PLUGIN_ROOT_PATTERN = new RegExp(
  `\\$\\{${PLUGIN_ROOT_VARIABLE}(?::[-=?+][^}]*)?\\}|\\$${PLUGIN_ROOT_VARIABLE}(?![A-Za-z0-9_])`,
  'g',
)

/** True when this text names the plugin root in any of its spellings. */
export function textReferencesPluginRoot(value: string): boolean {
  // A fresh lastIndex every call: the pattern is global and shared.
  PLUGIN_ROOT_PATTERN.lastIndex = 0
  return PLUGIN_ROOT_PATTERN.test(value)
}

/** Every string a server's declaration can hide the variable in. */
function declaredStrings(server: ScannedMcpServer): string[] {
  return [server.command, ...server.args, server.url, ...Object.values(server.env), ...Object.values(server.headers)]
}

/**
 * True when this server cannot start unless the plugin's own directory exists
 * on disk — which is what makes copying it part of the install rather than an
 * optimisation.
 */
export function referencesPluginRoot(server: ScannedMcpServer): boolean {
  return declaredStrings(server).some(textReferencesPluginRoot)
}

/** True when any server this plugin declares needs the plugin's own files. */
export function pluginNeedsOwnFiles(plugin: { components: { mcpServers: readonly ScannedMcpServer[] } }): boolean {
  return plugin.components.mcpServers.some(referencesPluginRoot)
}

function substitute(value: string, root: string): string {
  return value.replace(PLUGIN_ROOT_PATTERN, root)
}

function substituteRecord(record: Record<string, string>, root: string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, substitute(value, root)]))
}

/**
 * The same server with `${CLAUDE_PLUGIN_ROOT}` replaced by `root` everywhere it
 * appears.
 *
 * Two things happen beyond the textual replacement, and both matter:
 *
 *   - `root` is also exported into the server's environment. Substitution can
 *     only reach the strings this app can see; `bun run … start` runs a
 *     package.json script, and a script of its own that reads the variable gets
 *     the right answer this way instead of an empty string.
 *   - `CLAUDE_PLUGIN_ROOT` leaves `envVarNames`. That list is "variables the
 *     source names and somebody must fill in" — it is why the MCP sync warns
 *     that a server expects a variable nothing sets, and why the plugin pane
 *     says `needs CLAUDE_PLUGIN_ROOT`. Once this app has set it, going on
 *     asking for it would be a warning about a problem that is fixed.
 */
export function resolvePluginRoot(server: ScannedMcpServer, root: string): ScannedMcpServer {
  return {
    ...server,
    command: substitute(server.command, root),
    args: server.args.map((arg) => substitute(arg, root)),
    url: substitute(server.url, root),
    env: { ...substituteRecord(server.env, root), [PLUGIN_ROOT_VARIABLE]: root },
    headers: substituteRecord(server.headers, root),
    envVarNames: server.envVarNames.filter((name) => name !== PLUGIN_ROOT_VARIABLE),
  }
}
