// Claude Code's session markers, which must not reach a terminal this app opens.
//
// Claude Code stamps every process it spawns (its Bash tool, its hooks, its
// status line) with who spawned it: `CLAUDECODE=1`, the session id, and
// `CLAUDE_CODE_CHILD_SESSION=1`. A `claude` started under those markers treats
// itself as a nested session and turns transcript saving off — it shows
// "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker", and
// `--resume` later finds nothing. That is right for a `claude -p` run by an
// agent, and wrong for anything this app launches: the app is a host of its
// own, and every agent it starts is a top-level session the person expects to
// resume.
//
// The markers arrive whenever the app itself was started from inside a Claude
// Code session — a dev build run from a Claude Code terminal, or the packaged
// app opened by a script an agent ran — and the launch env is built from the
// app's own `process.env`. So they are removed from that base env, for agents
// and plain terminals alike: a `claude` typed into a plain terminal is exactly
// as top-level as one the app launched, and would lose its transcript the same
// way.
//
// The list is taken from the installed CLI (Claude Code 2.1.281, 2026-09-24),
// not guessed. It is the union of:
//
//   - what Claude Code sets on every child it spawns: CLAUDECODE,
//     CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION,
//     CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_PID, CLAUDE_EFFORT, plus
//     CLAUDE_CODE_EXECPATH and CLAUDE_CODE_INVOKED_SKILLS from its shell
//     environment; it reads none of these as configuration;
//   - what it deletes itself before starting an independent background
//     session: the four markers above, CLAUDE_CODE_BRIDGE_SESSION_ID, and the
//     terminal-identity set that includes CLAUDE_CODE_SSE_PORT (the parent's
//     IDE connection, which a new session would otherwise attach to);
//   - the handles a host hands the session it launches, which name that host
//     and that session and nothing else: CLAUDE_CODE_ENTRYPOINT (which surface
//     started it), CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN.
//
// Deliberately NOT here: anything a person sets to configure Claude Code —
// CLAUDE_CODE_USE_BEDROCK / _VERTEX, ANTHROPIC_* keys and endpoints, model and
// token settings, CLAUDE_CODE_PLUGIN_DIRS, proxies. Those describe the person's
// setup, not the session that happened to start the app, and the provider-env
// merge in terminal-launch.ts is where the app decides about any of them.
export const INHERITED_CLAUDE_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
] as const

const INHERITED_KEYS_UPPER = new Set<string>(INHERITED_CLAUDE_SESSION_ENV_KEYS)

/**
 * Remove the parent session's markers from an env record, on a copy.
 *
 * Matched case-insensitively: a Windows environment is, and a key spelled
 * `ClaudeCode` there is the same variable to the child.
 */
export function withoutInheritedSessionEnv(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!INHERITED_KEYS_UPPER.has(key.toUpperCase())) next[key] = value
  }
  return next
}
