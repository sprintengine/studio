// Part of the IPC contract: built-in skills, the studio plugin, and the plugin registry listing.
// ../electron-api.ts re-exports everything here.

import type { PluginRegistryListEntry } from '../plugin-manifest'
import type { SkillHarness } from '../skills'

export type BuiltinSkill = {
  id: string
  name: string
  version: string
  description: string
  harnesses?: SkillHarness[]
  targetPolicy?: 'agents' | 'all-native'
}

export type BuiltinSkillTargetState = {
  harness: string
  destinationPath?: string
  status: 'missing' | 'installed' | 'update-available' | 'modified' | 'local' | 'prompt-shim' | 'unsupported'
  installedVersion?: string
  pluginId?: string
  displayName?: string
  support?: 'native' | 'prompt-shim' | 'unsupported'
  installScope?: 'workspace' | 'user'
  format?: string
  restartRequired?: boolean
}

/**
 * What the catalogue's built-in row for the app's own plugin reads.
 * `installedVersion` is '' until this app run has installed into that
 * workspace; a value that differs from `bundledVersion` is the drift Sync
 * reports, and the next open closes it.
 */
export type StudioPluginStatus = {
  bundledVersion: string
  installedVersion: string
  skillDirNames: string[]
  claudePluginKey: string
  /** ISO timestamp the hooks acknowledgement was answered, '' when it has not been. */
  hooksAcknowledgedAt: string
}

export type BuiltinSkillStatus =
  | { ok: true; status: 'missing'; skill: BuiltinSkill; destinationPath: string; targets: BuiltinSkillTargetState[] }
  | {
      ok: true
      status: 'installed'
      skill: BuiltinSkill
      destinationPath: string
      installedVersion: string
      targets: BuiltinSkillTargetState[]
    }
  | {
      ok: true
      status: 'update-available'
      skill: BuiltinSkill
      destinationPath: string
      installedVersion: string
      targets: BuiltinSkillTargetState[]
    }
  | {
      ok: true
      status: 'modified'
      skill: BuiltinSkill
      destinationPath: string
      installedVersion: string
      targets: BuiltinSkillTargetState[]
    }
  | {
      ok: true
      status: 'local'
      skill: BuiltinSkill
      destinationPath: string
      message: string
      targets: BuiltinSkillTargetState[]
    }
  | { ok: false; status: 'unknown-skill' | 'missing-workspace' | 'missing-source'; skillId: string; message: string }

export type BuiltinSkillInstallResult =
  | {
      ok: true
      status: 'installed' | 'updated'
      skill: BuiltinSkill
      destinationPath: string
      skipped?: BuiltinSkillTargetState[]
    }
  | {
      ok: false
      status: 'unknown-skill' | 'missing-workspace' | 'missing-source' | 'modified' | 'local'
      skillId: string
      message: string
    }

export type PluginRegistryListResult = { ok: true; plugins: PluginRegistryListEntry[] } | { ok: false; message: string }
