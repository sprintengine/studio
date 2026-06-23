// Debug Mode injects a fixed directive ahead of the agent's initial prompt so
// any CLI — regardless of harness — runs the `debug` skill's file-backed state
// machine for the session. The toggle is orthogonal to the permission preset:
// it never changes launch flags, only the prompt. The `<MULTICODE_AGENT_ID>`
// placeholder stays literal here; the launched terminal already exports that env
// var (see agentIdentityEnv in terminal-launch.ts), so the agent resolves its
// own per-terminal state file at runtime.
export const DEBUG_DIRECTIVE =
  'You are in DEBUG MODE. Follow the `debug` skill\'s state machine. ' +
  'Treat `.multi-code/debug/<MULTICODE_AGENT_ID>.json` as your source of truth. ' +
  'Do not finish until all tagged instrumentation is removed.'

// Pure helper shared by main and renderer. Returns the prompt untouched when
// debug is off. When on, it prepends the directive; when a CLI-native skill
// invocation is supplied (e.g. "/debug" for Claude Code, "Use $debug." for
// Codex — resolved from the plugin manifest at the launch boundary), that
// invocation leads so Debug Mode triggers the skill through the CLI's first-class
// mechanism, with the directive immediately after as the always-present contract.
// An empty prompt yields just the directive lead, so a debug launch with no user
// prompt still carries the instruction.
export function applyDebugDirective(
  initialPrompt: string,
  debugMode: boolean,
  nativeInvocation?: string
): string {
  if (!debugMode) return initialPrompt
  const lead = nativeInvocation ? `${nativeInvocation}\n\n${DEBUG_DIRECTIVE}` : DEBUG_DIRECTIVE
  return initialPrompt ? `${lead}\n\n${initialPrompt}` : lead
}
