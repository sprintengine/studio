// Which agent CLI each agent-harness conversation provider rides.
//
// A chat agent is the same CLI a terminal agent runs, driven through its
// structured interface instead of its TUI. Main reads this to hide a provider
// whose CLI is not installed; the renderer reads it to offer the terminal
// agent's picker for a chat (the CLI rail, its models, its effort and its
// permission presets) and to map what that picker chose back onto the
// conversation provider. One table, so the two can never disagree about which
// CLIs have a chat runtime.
//
// Providers that are not a CLI (the API-key providers) are deliberately absent.

const CONVERSATION_PROVIDER_CLI: Readonly<Record<string, string>> = {
  'claude-agent': 'claude-code',
  'codex-agent': 'codex',
  'cursor-agent': 'cursor',
  'opencode-agent': 'opencode',
  'grok-agent': 'grok',
}

// The permission presets a CLI's chat cannot be held to, with the reason its
// row in the permission menu gives. The provider refuses them with the same
// sentence (acp-conversation-provider.ts), and the launcher and the chat box
// dim them rather than letting a chat start on something looser under the
// preset's name. A CLI missing here runs every preset.
const CONVERSATION_PERMISSION_PRESET_REFUSALS: Readonly<
  Record<string, Partial<Record<import('./cli-permission-preset').CliPermissionPreset, string>>>
> = {
  // Observed with Cursor's default allowlist: commands outside the allowlist
  // are sent for approval, file edits in the workspace are applied directly,
  // and no flag makes it ask about them.
  cursor: { manual: 'Cursor edits files without asking, so it cannot ask before every change.' },
}

/** The presets a CLI's chat cannot run, each with the reason; empty when it runs every one. */
export function conversationPermissionPresetRefusals(
  cli: string | null | undefined,
): Partial<Record<import('./cli-permission-preset').CliPermissionPreset, string>> {
  return (cli && CONVERSATION_PERMISSION_PRESET_REFUSALS[cli]) || {}
}

/** The CLI a conversation provider rides, or null for a provider that is not a CLI. */
export function cliForConversationProvider(providerId: string | null | undefined): string | null {
  return (providerId && CONVERSATION_PROVIDER_CLI[providerId]) || null
}

/** The conversation provider that drives a CLI as a chat, or null when the CLI has none. */
export function conversationProviderForCli(cli: string | null | undefined): string | null {
  if (!cli) return null
  for (const [providerId, providerCli] of Object.entries(CONVERSATION_PROVIDER_CLI)) {
    if (providerCli === cli) return providerId
  }
  return null
}

// The CLIs whose chat can run on a WSL machine: its child is started inside
// the distribution, with the login and settings under the Linux home. The
// other chat runtimes still start their CLI on this machine only.
const WSL_CHAT_CLIS: ReadonlySet<string> = new Set(['claude-code'])

/** Whether a CLI's chat can run on a WSL machine rather than only on this one. */
export function conversationRunsOnWsl(cli: string | null | undefined): boolean {
  return Boolean(cli && WSL_CHAT_CLIS.has(cli))
}

/**
 * The model id a chat asks its provider for when the picker is on the CLI's own
 * default row (no model chosen). Every harness provider treats it as "pass no
 * model", the same as a terminal launch without `--model`.
 */
export const CONVERSATION_DEFAULT_MODEL_ID = 'default'
