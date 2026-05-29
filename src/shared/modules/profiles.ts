import type { ModuleEnablementOverrides } from './manifest'

// Named module bundles for fast onboarding and one-click reconfiguration.
// Profiles are to capability modules what layout templates are to workspaces:
// a sensible starting set the user can refine. `agent-runtime` is the core
// module and is always on, so profiles only express the optional modules.
//
// A profile is an allowlist of the optional module ids it turns ON (or 'all').
// The override map is *derived* from the installed optional modules at apply
// time, so adding a new module can't silently leave it enabled in a lean
// profile — it defaults off unless the profile lists it (or the profile is
// 'all'). Pure/shared so the first-run chooser, the Settings → Modules manager,
// and any future main-side consumer all read the same definitions.

export type ModuleProfileId = 'minimal' | 'solo' | 'everything'

export type ModuleProfile = {
  id: ModuleProfileId
  name: string
  summary: string
  /** Optional module ids this profile enables, or 'all' for every optional module. */
  enabled: 'all' | string[]
}

export const MODULE_PROFILES: ModuleProfile[] = [
  {
    id: 'minimal',
    name: 'Minimal IDE',
    summary: 'Agent terminals, the editor, and git. The lightest setup.',
    enabled: ['dev-tools', 'git'],
  },
  {
    id: 'solo',
    name: 'Solo dev',
    summary: 'Editor, git, Sprint Engine, and the knowledge graph for working a project on your own.',
    enabled: ['dev-tools', 'git', 'sprint-engine', 'memory-graph'],
  },
  {
    id: 'everything',
    name: 'Command center',
    summary: 'Every capability, including Switchboard, Multiloop, and the mobile relay.',
    enabled: 'all',
  },
]

export function moduleProfile(id: ModuleProfileId): ModuleProfile | undefined {
  return MODULE_PROFILES.find((profile) => profile.id === id)
}

export function profileEnables(profile: ModuleProfile, moduleId: string): boolean {
  return profile.enabled === 'all' || profile.enabled.includes(moduleId)
}

// Build the enablement override map for a profile across the installed optional
// (non-core) module ids. Derived from the live module set so it stays correct as
// modules are added or removed.
export function profileOverrides(
  profile: ModuleProfile,
  optionalModuleIds: ReadonlyArray<string>
): ModuleEnablementOverrides {
  const overrides: ModuleEnablementOverrides = {}
  for (const id of optionalModuleIds) {
    overrides[id] = profileEnables(profile, id)
  }
  return overrides
}
