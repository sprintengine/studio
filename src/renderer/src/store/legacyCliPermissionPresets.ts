/**
 * The one-time handover of the per-CLI permission presets from this window's
 * localStorage to main's launch settings.
 *
 * The spawn footer's per-CLI choice used to live in localStorage, which main
 * could not read (a launch with no window open ran on the app-wide default)
 * and which each window cached and rewrote whole (two windows setting two CLIs
 * lost one of them). Main now owns the map. A profile that still has the old
 * key sends its entries once, only for the CLIs main holds nothing for, so a
 * choice made in another window since the upgrade is never overwritten. The
 * key is removed once main answers with a record on disk; until then the next
 * boot offers it again.
 */
import { normalizeCliPermissionPresets, type AgentLaunchSettingsPatch } from '../../../shared/launch-settings'
import type { CliPermissionPreset } from '../types/workspace'

export const LEGACY_CLI_PERMISSION_PRESETS_KEY = 'sprintengine.cli-permission-presets'

// Where the per-model-row store lived before that. It is not carried over: its
// entries were keyed "<cli>:<model>", several rows of one CLI could disagree,
// and no order among them says which was chosen last.
export const RETIRED_PER_MODEL_PRESETS_KEY = 'sprintengine.model-permission-presets'

type Storage = Pick<globalThis.Storage, 'getItem' | 'removeItem'>

export type LegacyCliPermissionPresetsMigration = {
  storage: Storage | null
  /** The per-CLI presets this window's read model holds from main. */
  held: () => Readonly<Record<string, CliPermissionPreset | undefined>>
  /** Main's `update`; resolves true when main's answer is on disk. */
  update: (patch: AgentLaunchSettingsPatch) => Promise<boolean>
}

function readLegacyMap(storage: Storage): Record<string, CliPermissionPreset> | null {
  try {
    const raw = storage.getItem(LEGACY_CLI_PERMISSION_PRESETS_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    // Values the old store would have dropped are dropped here too; an entry
    // it kept is a choice somebody made, read like any stored preset.
    const valid: Record<string, unknown> = {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [cli, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === 'none' || value === 'manual' || value === 'auto' || value === 'bypass') valid[cli] = value
      }
    }
    return normalizeCliPermissionPresets(valid)
  } catch {
    // A hand-corrupted value carries nothing worth sending; treat it as empty so
    // the key is still cleared.
    return {}
  }
}

function remove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // A blocked localStorage keeps the bytes; nothing reads them.
  }
}

/** Runs the handover. Resolves once it is done or has nothing to do. */
export async function migrateLegacyCliPermissionPresets(input: LegacyCliPermissionPresetsMigration): Promise<void> {
  const { storage } = input
  if (!storage) return
  remove(storage, RETIRED_PER_MODEL_PRESETS_KEY)
  const legacy = readLegacyMap(storage)
  if (legacy === null) return
  const held = input.held()
  const patch: Record<string, CliPermissionPreset> = {}
  for (const [cli, preset] of Object.entries(legacy)) {
    if (held[cli] === undefined) patch[cli] = preset
  }
  if (Object.keys(patch).length === 0) {
    remove(storage, LEGACY_CLI_PERMISSION_PRESETS_KEY)
    return
  }
  if (await input.update({ cliPermissionPresets: patch })) {
    remove(storage, LEGACY_CLI_PERMISSION_PRESETS_KEY)
  }
}
