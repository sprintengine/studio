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

/**
 * The model id a chat asks its provider for when the picker is on the CLI's own
 * default row (no model chosen). Every harness provider treats it as "pass no
 * model", the same as a terminal launch without `--model`.
 */
export const CONVERSATION_DEFAULT_MODEL_ID = 'default'
