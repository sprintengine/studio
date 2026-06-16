import assert from 'node:assert/strict'

import type {
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginVerifyResult,
} from '../../../../shared/electron-api'
import {
  classifyVerification,
  deriveInstallView,
  summarizeInstallResult,
  type InstallFlowState,
} from './installFlow'

// The trust gate must disclose REAL verified permissions before trust and must
// never fake an install: verified installs directly, community earns the trust
// prompt populated from the verify IPC, unsigned/invalid hard-block with no
// install affordance, and the seven flow states each render an explicit view.

function verify(overrides: Partial<MarketplacePluginVerifyResult> = {}): MarketplacePluginVerifyResult {
  return {
    classification: 'verified',
    permissions: [],
    sourceUrl: 'https://github.com/multicode-labs/marketplace/tree/main/plugins/x',
    ...overrides,
  }
}

// --- classifyVerification --------------------------------------------------

{
  // Verified → install directly (no trust prompt).
  const outcome = classifyVerification(verify({ classification: 'verified' }))
  assert.equal(outcome.kind, 'install')
}

{
  // Community → trust prompt populated with the REAL verified permissions.
  const outcome = classifyVerification(
    verify({ classification: 'community', permissions: ['network', 'filesystem:read-workspace'] }),
  )
  assert.equal(outcome.kind, 'needs-trust')
  if (outcome.kind !== 'needs-trust') throw new Error('unreachable')
  assert.deepEqual(outcome.permissions, ['network', 'filesystem:read-workspace'])
}

{
  // Community with no declared permissions: a real empty list, never fabricated.
  const outcome = classifyVerification(verify({ classification: 'community', permissions: [] }))
  assert.equal(outcome.kind, 'needs-trust')
  if (outcome.kind !== 'needs-trust') throw new Error('unreachable')
  assert.deepEqual(outcome.permissions, [])
}

{
  // Invalid signature → hard block, no install path; verifier message + issues kept.
  const outcome = classifyVerification(
    verify({
      classification: 'invalid',
      message: 'Downloaded plugin bundle signature is invalid.',
      issues: [{ path: 'signature', message: 'Invalid signature.' }],
    }),
  )
  assert.equal(outcome.kind, 'blocked')
  if (outcome.kind !== 'blocked') throw new Error('unreachable')
  assert.equal(outcome.classification, 'invalid')
  assert.match(outcome.message, /invalid/i)
  assert.deepEqual(outcome.issues, ['Invalid signature.'])
}

{
  // Unsigned → hard block too (architect ruling: unsigned is not trust-grantable).
  const outcome = classifyVerification(verify({ classification: 'unsigned' }))
  assert.equal(outcome.kind, 'blocked')
  if (outcome.kind !== 'blocked') throw new Error('unreachable')
  assert.equal(outcome.classification, 'unsigned')
  assert.ok(outcome.message.length > 0, 'falls back to a default unsigned message')
}

// --- summarizeInstallResult ------------------------------------------------

{
  const ok: MarketplacePluginRegistryInstallResult = {
    ok: true,
    id: 'x',
    displayName: 'X',
    version: 1,
    trust: 'trusted',
    loadEligible: true,
    installed: [],
    classification: 'verified',
    sourceUrl: 'https://example.com',
    updated: false,
  }
  assert.deepEqual(summarizeInstallResult(ok), { status: 'installed', updated: false })

  const updated: MarketplacePluginRegistryInstallResult = { ...ok, updated: true }
  assert.deepEqual(summarizeInstallResult(updated), { status: 'installed', updated: true })
}

{
  const failed: MarketplacePluginRegistryInstallResult = {
    ok: false,
    message: 'Could not write skill files.',
    issues: [{ path: 'skills', message: 'permission denied' }],
  }
  const state = summarizeInstallResult(failed)
  assert.equal(state.status, 'error')
  if (state.status !== 'error') throw new Error('unreachable')
  assert.equal(state.message, 'Could not write skill files.')
  assert.deepEqual(state.issues, ['permission denied'])
}

// --- deriveInstallView: all seven states -----------------------------------

{
  const v = deriveInstallView({ status: 'idle' })
  assert.deepEqual(v.action, { kind: 'install', label: 'Install' })
  assert.equal(v.busy, false)
  assert.equal(v.trustPrompt, false)
  assert.equal(v.notice, null)
}

{
  const v = deriveInstallView({ status: 'verifying' })
  assert.equal(v.action, null)
  assert.equal(v.busy, true)
  assert.equal(v.busyLabel, 'Verifying…')
}

{
  const v = deriveInstallView({ status: 'needs-trust', permissions: ['network'] })
  assert.deepEqual(v.action, { kind: 'trust-install', label: 'Trust and install' })
  assert.equal(v.trustPrompt, true)
  assert.deepEqual(v.permissions, ['network'])
  assert.equal(v.busy, false)
}

{
  const v = deriveInstallView({ status: 'installing' })
  assert.equal(v.action, null)
  assert.equal(v.busy, true)
  assert.equal(v.busyLabel, 'Installing…')
}

{
  const fresh = deriveInstallView({ status: 'installed', updated: false })
  assert.equal(fresh.action, null)
  assert.equal(fresh.notice?.tone, 'good')
  assert.match(fresh.notice?.message ?? '', /Installed/)

  const bumped = deriveInstallView({ status: 'installed', updated: true })
  assert.match(bumped.notice?.message ?? '', /Updated/)
}

{
  // Blocked: NO action (no install affordance), notice carries the reason.
  const invalid = deriveInstallView({ status: 'blocked', classification: 'invalid', message: 'bad sig', issues: ['x'] })
  assert.equal(invalid.action, null, 'invalid blocked offers no install affordance')
  assert.equal(invalid.notice?.tone, 'error')
  assert.deepEqual(invalid.notice?.issues, ['x'])

  const unsigned = deriveInstallView({ status: 'blocked', classification: 'unsigned', message: 'no sig' })
  assert.equal(unsigned.action, null, 'unsigned blocked offers no install affordance')
  assert.equal(unsigned.notice?.tone, 'warn')
}

{
  // Error: retry is offered (distinct from a hard block).
  const v = deriveInstallView({ status: 'error', message: 'network down' })
  assert.deepEqual(v.action, { kind: 'retry', label: 'Try again' })
  assert.equal(v.notice?.tone, 'error')
  assert.equal(v.notice?.message, 'network down')
}

// Exhaustiveness guard: deriveInstallView returns a view for every state shape.
const allStates: InstallFlowState[] = [
  { status: 'idle' },
  { status: 'verifying' },
  { status: 'needs-trust', permissions: [] },
  { status: 'installing' },
  { status: 'installed', updated: false },
  { status: 'blocked', classification: 'invalid', message: 'm' },
  { status: 'error', message: 'm' },
]
for (const state of allStates) {
  const v = deriveInstallView(state)
  assert.ok('action' in v && 'busy' in v && 'notice' in v, `state ${state.status} derives a complete view`)
}

console.log('installFlow.test.ts passed')
