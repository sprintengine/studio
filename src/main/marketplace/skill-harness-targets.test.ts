// resolveInstalledSkillHarnesses: the marketplace skill-install fan-out set is
// the shared `.agents` dir plus the native harness of every registered CLI
// whose binary probe says installed — absent, indeterminate, and non-native
// CLIs contribute nothing.

import assert from 'node:assert/strict'

import type { AgentCliAvailabilityMap } from '../../shared/electron-api'
import type { PluginRegistryListEntry, PluginSkillSupport } from '../../shared/plugin-manifest'
import { resolveInstalledSkillHarnesses } from './skill-harness-targets'

function cliEntry(id: string, harnessId: string, support: PluginSkillSupport = 'native'): PluginRegistryListEntry {
  return {
    id,
    displayName: id,
    source: 'bundled',
    version: 1,
    binary: id,
    resumeSession: false,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: {
      support,
      harnessId,
      installTargets: [
        {
          scope: 'workspace',
          path: `{{workspaceRoot}}/.${harnessId}/skills/{{skillId}}`,
          format: 'generic',
          restartRequired: false,
        },
      ],
    },
  }
}

function availability(installed: Record<string, boolean>): AgentCliAvailabilityMap {
  const map: AgentCliAvailabilityMap = {}
  for (const [cli, isInstalled] of Object.entries(installed)) {
    map[cli] = { cli, installed: isInstalled, resolvedPath: null, version: null }
  }
  return map
}

async function main(): Promise<void> {
  // Installed native CLIs contribute their harness; agents is always present;
  // output follows SKILL_PACK_HARNESSES order regardless of registry order.
  {
    const resolved = await resolveInstalledSkillHarnesses({
      listEntries: () => [cliEntry('codex', 'codex'), cliEntry('claude-code', 'claude')],
      detectAvailability: () => Promise.resolve(availability({ codex: true, 'claude-code': true })),
    })
    assert.deepEqual(resolved, ['claude', 'codex', 'agents'])
  }

  // Not installed, probe-indeterminate (absent from the map), prompt-shim
  // support, and unknown harness ids all contribute nothing.
  {
    const resolved = await resolveInstalledSkillHarnesses({
      listEntries: () => [
        cliEntry('codex', 'codex'), // installed: false below
        cliEntry('opencode', 'opencode'), // absent from availability map
        cliEntry('gemini', 'gemini', 'prompt-shim'), // no native support
        cliEntry('mystery', 'mystery'), // harness id outside SKILL_PACK_HARNESSES
        cliEntry('claude-code', 'claude'),
      ],
      detectAvailability: () => Promise.resolve(availability({ codex: false, mystery: true, 'claude-code': true })),
    })
    assert.deepEqual(resolved, ['claude', 'agents'])
  }

  // Two plugins mapping to one harness dedupe; either being installed keeps it.
  {
    const resolved = await resolveInstalledSkillHarnesses({
      listEntries: () => [cliEntry('claude-code', 'claude'), cliEntry('zai', 'claude')],
      detectAvailability: () => Promise.resolve(availability({ 'claude-code': false, zai: true })),
    })
    assert.deepEqual(resolved, ['claude', 'agents'])
  }

  // Nothing installed -> just the shared agents dir, never an empty set.
  {
    const resolved = await resolveInstalledSkillHarnesses({
      listEntries: () => [cliEntry('codex', 'codex')],
      detectAvailability: () => Promise.resolve(availability({ codex: false })),
    })
    assert.deepEqual(resolved, ['agents'])
  }

  console.log('skill harness targets tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
