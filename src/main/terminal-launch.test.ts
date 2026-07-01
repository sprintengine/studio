import assert from 'node:assert/strict'

import { mergeProviderLaunchEnv } from './terminal-launch'

async function main(): Promise<void> {
  testNoOpWithoutProviderEnv()
  testProviderEnvWinsOnCollision()
  testStripsApiKeyOnBaseUrlRedirectWithoutToken()
  testStripsApiKeyWhenTokenSet()
  testKeepsApiKeyWhenNoAnthropicRedirect()
  testNeverOverridesProtectedKeys()
  console.log('terminal-launch tests passed')
}

// A manifest with no launch.env must not touch the base env at all.
function testNoOpWithoutProviderEnv(): void {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'real-key' }
  assert.equal(mergeProviderLaunchEnv(base, undefined), base, 'undefined provider env returns base by reference')
  assert.equal(mergeProviderLaunchEnv(base, {}), base, 'empty provider env returns base by reference')
}

function testProviderEnvWinsOnCollision(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', FOO: 'base' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', FOO: 'provider' }
  )
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(out.FOO, 'provider')
}

// The critical leak case: endpoint redirected but NO token configured, while a
// real ANTHROPIC_API_KEY is inherited. It must be stripped so the real key is
// never sent to the redirect target (the launch fails closed instead).
function testStripsApiKeyOnBaseUrlRedirectWithoutToken(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_API_KEY: 'real-anthropic-key', PATH: '/bin' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' }
  )
  assert.equal('ANTHROPIC_API_KEY' in out, false, 'inherited real key must not survive an endpoint redirect')
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(out.PATH, '/bin')
}

function testStripsApiKeyWhenTokenSet(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_API_KEY: 'real-anthropic-key' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-token' }
  )
  assert.equal('ANTHROPIC_API_KEY' in out, false)
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'zai-token')
}

// A provider env that does not touch the Anthropic endpoint must leave an
// inherited ANTHROPIC_API_KEY alone (no over-stripping).
function testKeepsApiKeyWhenNoAnthropicRedirect(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_API_KEY: 'real-anthropic-key' },
    { SOME_OTHER_VAR: 'x' }
  )
  assert.equal(out.ANTHROPIC_API_KEY, 'real-anthropic-key')
  assert.equal(out.SOME_OTHER_VAR, 'x')
}

// Identity/terminal keys are owned by the host and must never be clobbered by a
// manifest's launch.env, even a malicious one.
function testNeverOverridesProtectedKeys(): void {
  const out = mergeProviderLaunchEnv(
    { TERM: 'xterm-256color', MULTICODE_AGENT_ID: 'agent-1', PATH: '/bin' },
    { TERM: 'evil', MULTICODE_AGENT_ID: 'spoofed', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
  )
  assert.equal(out.TERM, 'xterm-256color', 'TERM is protected')
  assert.equal(out.MULTICODE_AGENT_ID, 'agent-1', 'agent identity is protected')
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic', 'non-protected keys still apply')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
