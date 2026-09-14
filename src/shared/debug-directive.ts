import { knownSidecarDirName } from './workspace-sidecar'
// Debug Mode injects a fixed directive ahead of the agent's initial prompt so
// any CLI — regardless of harness — runs the `debug` skill's file-backed state
// machine for the session. The toggle is orthogonal to the permission preset:
// it never changes launch flags, only the prompt. The `<SPRINTENGINE_AGENT_ID>`
// placeholder stays literal here; the launched terminal already exports that env
// var (see agentIdentityEnv in terminal-launch.ts), so the agent resolves its
// own per-terminal state file at runtime.
//
// The sidecar directory is named per workspace, because a workspace made before
// the rename keeps its state under the old name and the agent has to create its
// scratch file in the directory that is actually there — a stray `.sprintengine/`
// next to a live `.multi-code/` is how a workspace loses track of its own state.
export function debugDirectiveFor(workspaceRoot = ''): string {
  return 'You are in DEBUG MODE. Follow the `debug` skill\'s state machine. '
    + `Treat \`${knownSidecarDirName(workspaceRoot)}/debug/<SPRINTENGINE_AGENT_ID>.json\` as your source of truth. `
    + 'Do not finish until all tagged instrumentation is removed.'
}

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
  nativeInvocation?: string,
  workspaceRoot?: string
): string {
  if (!debugMode) return initialPrompt
  const directive = debugDirectiveFor(workspaceRoot)
  const lead = nativeInvocation ? `${nativeInvocation}\n\n${directive}` : directive
  return initialPrompt ? `${lead}\n\n${initialPrompt}` : lead
}
