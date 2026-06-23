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
// debug is off; when on, prepends the verbatim directive (with a blank line
// before any existing prompt). An empty prompt yields just the directive, so a
// debug launch with no user prompt still carries the instruction.
export function applyDebugDirective(initialPrompt: string, debugMode: boolean): string {
  if (!debugMode) return initialPrompt
  return initialPrompt ? `${DEBUG_DIRECTIVE}\n\n${initialPrompt}` : DEBUG_DIRECTIVE
}
