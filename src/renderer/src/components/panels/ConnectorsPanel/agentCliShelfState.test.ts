import assert from 'node:assert/strict'

import type { CliAvailability } from '../../../../../shared/electron-api'
import { agentCliPlatformLabel, agentCliShelfRowState, type CliInstallMethodsLoad } from './agentCliShelfState'

// MC-1858 — the CLI shelf row's state model, every branch. The contract under
// test: runtime state comes from the shared probe reading (a missing map entry
// is a FAILED probe, never an absent binary), and Install is offered only on a
// definitive negative probe with a real install path for this platform.

const installed: CliAvailability = {
  cli: 'claude-code',
  installed: true,
  resolvedPath: '/usr/local/bin/claude',
  version: '2.4.1',
}
const absent: CliAvailability = { cli: 'cursor', installed: false, resolvedPath: null, version: null }

const npmMethod = {
  id: 'npm',
  label: 'npm',
  available: true,
  unavailableReason: null,
  recommended: true,
  commandPreview: 'npm install -g x',
  platform: 'darwin',
}

const unknownMethods: CliInstallMethodsLoad = { status: 'unknown' }
const noMethods: CliInstallMethodsLoad = { status: 'ready', methods: [] }
const someMethods: CliInstallMethodsLoad = { status: 'ready', methods: [npmMethod] }

function state(overrides: Partial<Parameters<typeof agentCliShelfRowState>[0]>) {
  return agentCliShelfRowState({
    catalogStatus: 'ready',
    inCatalog: true,
    availability: undefined,
    availabilityStatus: 'ready',
    installMethods: unknownMethods,
    platform: 'darwin',
    useWsl: false,
    ...overrides,
  })
}

// Until the plugin catalog answers, installed-vs-built-in is unknown.
{
  const s = state({ catalogStatus: 'loading' })
  assert.equal(s.words, 'Checking…')
  assert.equal(s.action, 'none')
}

// A failed catalog read is its own state, never a guess.
{
  const s = state({ catalogStatus: 'error' })
  assert.match(s.words ?? '', /Runtime state unavailable/)
  assert.equal(s.action, 'none')
}

// The provider-kind bundled plugins (claude-agent, openrouter, xai) have no
// binary and no install spec: catalogue content with nothing to install.
{
  const s = state({ inCatalog: false })
  assert.equal(s.words, 'Built into the app — nothing to install')
  assert.equal(s.tone, 'neutral')
  assert.equal(s.action, 'none')
}

// Installed: version rides the mono slot, state comes from the shared probe
// vocabulary (rendered by CliProviderStateLine), and there is nothing to offer.
{
  const s = state({ availability: installed })
  assert.equal(s.version, '2.4.1')
  assert.equal(s.words, null)
  assert.equal(s.provider?.health, 'ready')
  assert.equal(s.action, 'none')
}

// Definitively absent WITH an install path: the one state that offers Install.
{
  const s = state({ availability: absent, installMethods: someMethods })
  assert.equal(s.provider?.health, 'missing')
  assert.equal(s.action, 'install')
}

// Definitively absent, methods not yet known: no button either way — a button
// shown before the platform answer could be a dead one.
{
  const s = state({ availability: absent, installMethods: unknownMethods })
  assert.equal(s.action, 'none')
  assert.equal(s.provider?.health, 'missing')
}

// No install path on this platform: named, never a dead button.
{
  const s = state({ availability: absent, installMethods: noMethods })
  assert.equal(s.words, 'Not available on macOS')
  assert.equal(s.tone, 'neutral')
  assert.equal(s.action, 'none')

  assert.equal(
    state({ availability: absent, installMethods: noMethods, platform: 'win32' }).words,
    'Not available on Windows',
  )
  assert.equal(
    state({ availability: absent, installMethods: noMethods, platform: 'win32', useWsl: true }).words,
    'Not available on WSL',
  )
  assert.equal(
    state({ availability: absent, installMethods: noMethods, platform: 'linux' }).words,
    'Not available on Linux',
  )
}

// A missing availability entry is a FAILED probe (detectAgentCliAvailability
// omits errored probes), so it must not render as installable — the same signal
// the deployment pickers hide uninstalled CLIs on.
{
  const readyBatch = state({ availability: undefined, availabilityStatus: 'ready', installMethods: someMethods })
  assert.equal(readyBatch.provider?.health, 'unknown')
  assert.equal(readyBatch.action, 'none')

  const failedBatch = state({ availability: undefined, availabilityStatus: 'error', installMethods: someMethods })
  assert.equal(failedBatch.provider?.health, 'probe-failed')
  assert.equal(failedBatch.action, 'none')

  const probing = state({ availability: undefined, availabilityStatus: 'loading' })
  assert.equal(probing.provider?.health, 'checking')
  assert.equal(probing.action, 'none')
}

assert.equal(agentCliPlatformLabel('darwin', false), 'macOS')

console.log('agent-cli shelf state model passed')
