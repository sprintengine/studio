import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentCli, CliDetectResult, CliRuntimeSettings } from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import {
  clearCliAvailabilityCache,
  detectAgentCliAvailability,
  invalidateCliAvailability,
} from './cli-availability'

function entry(id: string): PluginRegistryListEntry {
  return { id, displayName: id, source: 'bundled', version: 1, binary: id }
}

function detected(cli: AgentCli, installed: boolean, error: string | null = null): CliDetectResult {
  return {
    cli,
    binary: cli,
    installed,
    version: installed ? '1.0.0' : null,
    resolvedPath: installed ? `/usr/bin/${cli}` : null,
    useWsl: false,
    error,
  }
}

test('reports installed flag per registered CLI', async () => {
  clearCliAvailabilityCache()
  const result = await detectAgentCliAvailability(undefined, {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli) => detected(cli, cli === 'codex'),
    now: () => 1000,
  })
  assert.equal(result.codex.installed, true)
  assert.equal(result.codex.resolvedPath, '/usr/bin/codex')
  assert.equal(result['claude-code'].installed, false)
  assert.equal(result['claude-code'].resolvedPath, null)
})

test('caches a successful probe within the TTL window', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  await detectAgentCliAvailability(undefined, deps)
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 1)
})

test('re-probes once the cache entry expires', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  let clock = 1000
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => clock,
    ttlMs: 100,
  }
  await detectAgentCliAvailability(undefined, deps)
  clock = 1200 // past the 100ms TTL
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 2)
})

test('force bypasses the cache', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  await detectAgentCliAvailability(undefined, deps)
  await detectAgentCliAvailability({ force: true }, deps)
  assert.equal(probes, 2)
})

test('omits an errored probe from the map and does not cache it', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli: AgentCli) => {
      probes += 1
      // codex probes cleanly (installed); claude-code's probe errors transiently.
      return cli === 'codex' ? detected(cli, true) : detected(cli, false, 'shell spawn failed')
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  const first = await detectAgentCliAvailability(undefined, deps)
  // An errored probe must NOT appear as installed:false — it is omitted so the
  // renderer treats it as unknown and keeps the CLI visible.
  assert.equal('claude-code' in first, false, 'errored CLI is absent from the map')
  assert.equal(first.codex.installed, true)
  // codex (clean) is cached; claude-code (errored) is not, so it re-probes.
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes, 3, 'codex cached (1 probe), claude-code re-probed (2 probes)')
})

test('invalidateCliAvailability forces a re-probe for one CLI only', async () => {
  clearCliAvailabilityCache()
  const probes: Record<string, number> = { codex: 0, 'claude-code': 0 }
  const deps = {
    listEntries: () => [entry('codex'), entry('claude-code')],
    detect: async (cli: AgentCli) => {
      probes[cli] += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  await detectAgentCliAvailability(undefined, deps)
  invalidateCliAvailability('claude-code')
  await detectAgentCliAvailability(undefined, deps)
  assert.equal(probes.codex, 1) // still cached
  assert.equal(probes['claude-code'], 2) // invalidated -> re-probed
})

test('keys the cache by command/WSL override so a changed override re-probes', async () => {
  clearCliAvailabilityCache()
  let probes = 0
  const deps = {
    listEntries: () => [entry('codex')],
    detect: async (cli: AgentCli) => {
      probes += 1
      return detected(cli, true)
    },
    now: () => 5000,
    ttlMs: 60_000,
  }
  const runtimes: Record<AgentCli, Partial<CliRuntimeSettings>> = { codex: { command: '/a/codex' } }
  await detectAgentCliAvailability({ cliRuntimes: runtimes }, deps)
  await detectAgentCliAvailability({ cliRuntimes: { codex: { command: '/b/codex' } } }, deps)
  assert.equal(probes, 2)
})
