// Which harness dirs a marketplace skill install fans out to. SKILL.md
// content is harness-portable instructions, so the honest target set is the
// shared `.agents` dir plus the native skills dir of every agent CLI that is
// (a) registered with native skill support (the MC-47 adapter model — same
// signal builtin all-native skills use) and (b) actually installed on this
// machine per the binary probe. CLIs that are missing, probe-indeterminate,
// or without native skill support get no directory writes — a copy nothing
// can read is not an install.

import type { AgentCliAvailabilityMap, SkillHarness } from '../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../shared/plugin-manifest'
import { SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import { detectAgentCliAvailability } from '../cli-availability'
import { listPluginRegistryEntries } from '../plugin-registry-instance'

export type ResolveInstalledSkillHarnessesDeps = {
  listEntries?: () => PluginRegistryListEntry[]
  detectAvailability?: () => Promise<AgentCliAvailabilityMap>
}

export async function resolveInstalledSkillHarnesses(
  deps: ResolveInstalledSkillHarnessesDeps = {},
): Promise<SkillHarness[]> {
  const listEntries = deps.listEntries ?? listPluginRegistryEntries
  // Probed without per-CLI command overrides (those live in renderer
  // settings); a CLI on a custom command may probe as absent and only miss
  // its native copy — the `.agents` copy still installs.
  const detectAvailability = deps.detectAvailability ?? (() => detectAgentCliAvailability())
  const availability = await detectAvailability()
  const wanted = new Set<SkillHarness>(['agents'])
  for (const entry of listEntries()) {
    const integration = entry.skillIntegration
    if (integration?.support !== 'native') continue
    if (availability[entry.id]?.installed !== true) continue
    const harness = integration.harnessId as SkillHarness
    if (!SKILL_PACK_HARNESSES.includes(harness)) continue
    wanted.add(harness)
  }
  // Emit in SKILL_PACK_HARNESSES order so receipts stay stable across
  // installs regardless of registry enumeration order.
  return SKILL_PACK_HARNESSES.filter((harness) => wanted.has(harness))
}
