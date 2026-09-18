// The prompt a FRESHLY LAUNCHED agent is handed when a Backlog item is given to
// it. Two surfaces do that — the item detail pane's "Hand to agent" (renderer)
// and the automation `backlog.work` tool (main) — and both must state the same
// lifecycle contract in the same words, so the wording lives here rather than
// beside either caller. (Dropping an item onto a RUNNING terminal is the third
// door; it pastes the CLI's invocation alone — see utils/terminalDrop.)

/** The built-in skill that owns Backlog item lifecycle. */
export const BACKLOG_SKILL_ID = 'backlog'

/**
 * The CLI-agnostic handoff, for a plugin that declares no file-drop invocation
 * template (and for an unknown CLI): name the item and restate the lifecycle
 * contract the Backlog skill would otherwise carry, so any agent can follow it
 * without the skill being resolvable by name.
 */
export function backlogLifecycleHandoffPrompt(relativePath: string): string {
  return (
    `Work the Backlog item at ${relativePath}. ` +
    'Use the SprintEngine Studio MCP backlog.update tool for every lifecycle change: set `in_progress` when ' +
    'you start, `needs_input` (and state the blocking question) if you stop for input, and `completed` only ' +
    'after the work is real and verified — the tool stamps the update timestamp for you.'
  )
}
