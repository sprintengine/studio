// extensionUpdates — pure, DOM-free derivation for the manage canvas's update
// banner (MC-1873). The owner ruling pins the shape: staleness is ONE calm
// banner above the affected group, never an in-row badge and never a stack —
// several pending updates collapse to a single line. Copy always carries the
// version delta ("Acme Design Kit update · v1 → v2"), never a bare "Update
// available". Versions are plain integers (never semver), rendered as `v{n}`.
//
// Honesty rules, mirrored from the engine half (update-state.ts):
// - registry unreachable ⇒ "couldn't check for updates", never "up to date";
// - `ahead-of-registry` (a local dev build) is neither an update nor an error
//   and draws nothing;
// - `not-in-registry` (a purely local install) makes no claim and draws
//   nothing.
//
// The banner covers capability modules only. CLI plugins have NO staleness
// detection (owner-pinned split — a CLI binary's "latest" belongs to its
// vendor): their rows offer an Update action without ever claiming a newer
// version exists, so cli-only registry entries are excluded here.

import type { MarketplaceUpdateStatesResult } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'

export type ManageUpdate = {
  id: string
  name: string
  installedVersion: number
  latestVersion: number
}

export type ManageUpdateBanner =
  | { kind: 'none' }
  // The registry could not be read (or the local receipt store could not):
  // the check did not happen, and silence would read as "up to date".
  | { kind: 'couldnt-check' }
  | { kind: 'updates'; updates: ManageUpdate[] }

// Registry entries whose banner claim would violate the CLI split: provides
// 'cli' and no 'module'. A bundle that carries both is module-shaped enough
// to earn the banner.
export function cliOnlyRegistryIds(plugins: MarketplacePluginEntry[]): Set<string> {
  return new Set(
    plugins
      .filter((plugin) => plugin.provides.includes('cli') && !plugin.provides.includes('module'))
      .map((plugin) => plugin.id),
  )
}

export function deriveManageUpdateBanner(
  result: MarketplaceUpdateStatesResult | null,
  excludedIds: ReadonlySet<string>,
): ManageUpdateBanner {
  // Not read yet (or the running build predates the API): no claim either way.
  if (!result) return { kind: 'none' }
  if (!result.ok) return { kind: 'couldnt-check' }
  if (!result.checked) {
    // Nothing installed means nothing to check — no line. Anything installed
    // gets the honest couldn't-check, never silence-that-reads-as-current.
    return result.entries.length > 0 ? { kind: 'couldnt-check' } : { kind: 'none' }
  }
  const updates: ManageUpdate[] = []
  for (const entry of result.entries) {
    if (excludedIds.has(entry.id)) continue
    if (entry.availability.state !== 'update-available') continue
    updates.push({
      id: entry.id,
      name: entry.displayName,
      installedVersion: entry.availability.installedVersion,
      latestVersion: entry.availability.latestVersion,
    })
  }
  return updates.length > 0 ? { kind: 'updates', updates } : { kind: 'none' }
}

// The banner line and its one action. Single update: the name, the delta, and
// "Update to v2". Several: the collapsed "Updates available · N extensions"
// with "Update all" — one banner, never a stack.
export type ManageUpdateBannerCopy = {
  // The emphasised leading fragment (the extension name), null for the
  // collapsed multi-update line.
  strong: string | null
  text: string
  actionLabel: string
}

export function manageUpdateBannerCopy(updates: ManageUpdate[]): ManageUpdateBannerCopy {
  if (updates.length === 1) {
    const update = updates[0]
    return {
      strong: update.name,
      text: ` update · v${update.installedVersion} → v${update.latestVersion}`,
      actionLabel: `Update to v${update.latestVersion}`,
    }
  }
  return {
    strong: null,
    text: `Updates available · ${updates.length} extensions`,
    actionLabel: 'Update all',
  }
}

export const COULDNT_CHECK_COPY = 'Couldn’t check for updates'
