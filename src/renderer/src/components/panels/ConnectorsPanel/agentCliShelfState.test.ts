import assert from 'node:assert/strict'

import type { CliAvailability } from '../../../../../shared/electron-api'
import type { CliVersionAdvisory, CliVersionAdvisoryMap } from '../../../../../shared/electron-api'
import {
  agentCliPlatformLabel,
  agentCliShelfRowState,
  cliUpdateAvailable,
  countCliUpdates,
  type CliInstallMethodsLoad,
} from './agentCliShelfState'
import { test } from 'vitest'

test('agentCliShelfState', async () => {
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

  // ── present: what the row recedes on ────────────────────────────────────────
  //
  // `present` decides whether a row drops a contrast step, so the states that are
  // merely UNKNOWN must not read as absence: receding a row whose probe never
  // answered puts a CLI that is very likely installed into the background.
  {
    assert.equal(state({ catalogStatus: 'loading' }).present, true, 'a catalog still loading is not absence')
    assert.equal(state({ catalogStatus: 'error' }).present, true, 'an unreadable catalog is not absence')
    assert.equal(state({ inCatalog: false }).present, true, 'built into the app IS present')
    assert.equal(state({ availability: installed }).present, true, 'an installed CLI is present')
    assert.equal(
      state({ availability: undefined, availabilityStatus: 'error' }).present,
      true,
      'a FAILED probe is not absence — the row keeps its full weight and offers no Install',
    )
    assert.equal(
      state({ availability: absent, installMethods: someMethods }).present,
      false,
      'a definitive negative probe is absence',
    )
    assert.equal(
      state({ availability: absent, installMethods: noMethods }).present,
      false,
      'and so is a platform with no install path at all',
    )
  }

  // ── Updates ─────────────────────────────────────────────────────────────────
  //
  // `behind_latest` is the one status that means there is something to do. The
  // other two are silence, and a badge over silence is a badge that cries wolf.
  {
    const advisory = (status: CliVersionAdvisory['status'], latest: string | null): CliVersionAdvisory => ({
      cli: 'codex',
      status,
      currentVersion: '0.153.3',
      latestVersion: latest,
      updateCommand: null,
      checkedAt: '2026-09-10T00:00:00.000Z',
    })

    assert.equal(cliUpdateAvailable(advisory('behind_latest', '0.153.4')), true)
    assert.equal(cliUpdateAvailable(advisory('current', '0.153.3')), false)
    assert.equal(cliUpdateAvailable(advisory('unknown', null)), false, 'a registry we could not read says nothing')
    assert.equal(cliUpdateAvailable(undefined), false, 'and neither does a CLI with no advisory at all')

    const advisories = {
      codex: advisory('behind_latest', '0.153.4'),
      cursor: { ...advisory('behind_latest', '2.0.0'), cli: 'cursor' },
      'claude-code': { ...advisory('current', '2.4.1'), cli: 'claude-code' },
    } as unknown as CliVersionAdvisoryMap

    assert.equal(countCliUpdates(advisories, ['codex', 'cursor', 'claude-code']), 2)
    assert.equal(
      countCliUpdates(advisories, ['codex']),
      1,
      'counted over what the tab LISTS — a tab saying 2 above one row is two answers to one word',
    )
    assert.equal(countCliUpdates(advisories, ['codex', 'codex']), 1, 'a CLI listed twice is still one update')
    assert.equal(countCliUpdates({}, ['codex']), 0, 'no advisories, no count')
  }
})
