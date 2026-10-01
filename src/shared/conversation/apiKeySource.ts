// The credential source Claude Code reports on its `system/init` message. The
// values are the SDK's `ApiKeySource` union. Only three of them mean the
// session bills API usage: `none` is what a claude.ai subscription login (or a
// bearer token, or a cloud provider) reports, and the rest are legacy members
// current CLIs never emit — `oauth` among them, which would read as a
// subscription if one ever arrived.
const KNOWN_API_KEY_SOURCES = new Set([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
])

// Where each billing source comes from, worded for the chat's warning. The
// provider strips ANTHROPIC_API_KEY from the child's environment, so a session
// still reporting it got the key from the `env` block of the Claude settings.
const API_KEY_BILLING_SOURCES: Record<string, string> = {
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY, set in your environment or the env block of your Claude settings',
  apiKeyHelper: 'the apiKeyHelper command in your Claude settings',
  '/login managed key': 'the API key saved by a Console /login',
}

/**
 * A reported source kept only when it is one of the SDK's labels. The field is
 * carried into the transcript unredacted, so anything else — a future value, a
 * shape the CLI changed — is dropped rather than written to disk verbatim.
 */
export function normalizeApiKeySource(value: unknown): string | null {
  return typeof value === 'string' && KNOWN_API_KEY_SOURCES.has(value) ? value : null
}

/** The chat's warning for a session billing API usage, or null for one on the subscription. */
export function apiKeyBillingNotice(source: string | null | undefined): string | null {
  if (!source || !Object.hasOwn(API_KEY_BILLING_SOURCES, source)) return null
  return `This session is billing API usage, not your subscription. Its key comes from ${API_KEY_BILLING_SOURCES[source]}.`
}
