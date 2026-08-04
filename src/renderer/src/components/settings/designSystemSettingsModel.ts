import type { DesignSystemProvenance } from '../../../../shared/design-system/manifest'
import { DESIGN_SYSTEM_VERSION_PATTERN } from '../../../../shared/design-system/manifest'
import type { DesignSystemLibraryEntry } from '../../../../shared/design-system/library'

// DOM-free view-model for the Settings design-system section: where the
// attached copy came from, and whether the library holds a newer release of
// the same system. Kept out of the component so both decisions stay
// unit-testable without a renderer.

/**
 * Where the workspace's `design-system/` came from, read off the provenance
 * the attach flow stamps into the copy. `authored` covers everything attach
 * never touched: a bundle scaffolded or written in place.
 */
export type DesignSystemBundleOrigin = 'library' | 'folder' | 'authored'

export function resolveBundleOrigin(
  provenance: DesignSystemProvenance | undefined,
): DesignSystemBundleOrigin {
  if (!provenance) return 'authored'
  if (provenance.sourceLibraryId != null) return 'library'
  if (provenance.attachedAt != null) return 'folder'
  return 'authored'
}

export const BUNDLE_ORIGIN_LABEL: Record<DesignSystemBundleOrigin, string> = {
  library: 'from your library',
  folder: 'from an imported folder',
  authored: 'created in this project',
}

/**
 * Semver order for bundle versions (`major.minor.patch[-prerelease]`).
 * Returns <0, 0, >0. A prerelease sorts below the release of the same triple;
 * two prereleases on one triple compare as plain strings — close enough for
 * "is there something newer", which only needs a stable, monotonic answer.
 */
export function compareBundleVersions(a: string, b: string): number {
  const parse = (value: string): { triple: number[]; pre: string | null } => {
    const [core, ...preParts] = value.split('-')
    return {
      triple: core.split('.').map((part) => Number.parseInt(part, 10)),
      pre: preParts.length > 0 ? preParts.join('-') : null,
    }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    const delta = (left.triple[index] ?? 0) - (right.triple[index] ?? 0)
    if (delta !== 0) return delta
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * The library entry offering the newest version of the attached system, or
 * null when nothing newer is registered. Matches by manifest NAME — the
 * registry is keyed by path and two clones may share a name, so among the
 * readable same-name entries the highest version wins. An entry whose folder
 * cannot be read right now is never offered: updating from it would fail at
 * the copy with a worse message.
 */
export function findLibraryUpdate(
  attached: { name: string; version: string },
  entries: DesignSystemLibraryEntry[],
): DesignSystemLibraryEntry | null {
  let best: DesignSystemLibraryEntry | null = null
  for (const entry of entries) {
    if (entry.sourceState !== 'ok') continue
    if (entry.name !== attached.name) continue
    if (entry.version == null || !DESIGN_SYSTEM_VERSION_PATTERN.test(entry.version)) continue
    if (compareBundleVersions(entry.version, attached.version) <= 0) continue
    if (best?.version != null && compareBundleVersions(entry.version, best.version) <= 0) continue
    best = entry
  }
  return best
}
