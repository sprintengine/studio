import type { ModuleEnablementOverrides } from './manifest'

// Named module bundles for fast onboarding and one-click reconfiguration.
// Profiles are to capability modules what layout templates are to workspaces:
// a sensible starting set the user can refine. `agent-runtime` is the core
// module and is always on, so profiles only express the optional modules.
//
// Pure/shared so the first-run chooser, the Settings → Modules manager, and any
// future main-side consumer all read the same definitions.

export type ModuleProfileId = 'minimal' | 'solo' | 'everything'

export type ModuleProfile = {
  id: ModuleProfileId
  name: string
  summary: string
  /** Explicit enablement for every optional (non-core) module. */
  modules: ModuleEnablementOverrides
}

// Keys cover every optional module id. agent-runtime is core and omitted (its
// override is ignored by the resolver anyway).
export const MODULE_PROFILES: ModuleProfile[] = [
  {
    id: 'minimal',
    name: 'Minimal IDE',
    summary: 'Agent terminals, the editor, and git. The lightest setup.',
    modules: {
      'dev-tools': true,
      git: true,
      'memory-graph': false,
      switchboard: false,
      multiloop: false,
      'sprint-engine': false,
      'mobile-relay': false,
    },
  },
  {
    id: 'solo',
    name: 'Solo dev',
    summary: 'Editor, git, Sprint Engine, and the knowledge graph for working a project on your own.',
    modules: {
      'dev-tools': true,
      git: true,
      'memory-graph': true,
      'sprint-engine': true,
      switchboard: false,
      multiloop: false,
      'mobile-relay': false,
    },
  },
  {
    id: 'everything',
    name: 'Command center',
    summary: 'Every capability, including Switchboard, Multiloop, and the mobile relay.',
    modules: {
      'dev-tools': true,
      git: true,
      'memory-graph': true,
      'sprint-engine': true,
      switchboard: true,
      multiloop: true,
      'mobile-relay': true,
    },
  },
]

export function moduleProfile(id: ModuleProfileId): ModuleProfile | undefined {
  return MODULE_PROFILES.find((profile) => profile.id === id)
}
