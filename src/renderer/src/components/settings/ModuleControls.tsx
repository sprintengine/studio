import type { CapabilityCategory, CapabilityManifest } from '../../../../shared/modules/manifest'
import { ACTIVE_RENDERER_MODULE_MANIFESTS, COMING_SOON_MODULE_MANIFESTS } from '../../modules'

// Capability-module controls: the category grouping/labels shared by the
// Settings → Modules manager and the first-run chooser, plus the chooser's
// compact toggle list (with feature-flagged modules as greyed-out "Coming
// soon" rows). The Settings manager renders the richer card surface in
// ModulesSettingsTab but consumes the same groups so the two surfaces never
// disagree about what exists or what it's called.

const CATEGORY_ORDER: CapabilityCategory[] = [
  'core',
  'dev-tools',
  'vcs',
  'orchestration',
  'insight',
  'connectivity',
]

// Plain-language section headers shown in both Settings → Modules and the
// first-run chooser (kept here so the two surfaces stay identical). Prefer
// everyday wording over internal category ids — e.g. "Planning & automation" rather
// than the raw "orchestration".
const CATEGORY_LABEL: Record<string, string> = {
  core: 'Core',
  'dev-tools': 'Dev tools',
  vcs: 'Version control',
  orchestration: 'Planning & automation',
  insight: 'Insights',
  connectivity: 'Connections',
}

function categoryRank(category: CapabilityCategory | undefined): number {
  const index = CATEGORY_ORDER.indexOf(category ?? 'orchestration')
  return index === -1 ? CATEGORY_ORDER.length : index
}

// Human-readable section header for a category. Known categories use the curated
// labels above; an unmapped one (e.g. a third-party module's own category) is
// title-cased rather than shown as a raw id like "my-tools".
export function categoryLabel(category: CapabilityCategory): string {
  const mapped = CATEGORY_LABEL[category]
  if (mapped) return mapped
  const words = category.replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other'
}

// Ids of the feature-flagged modules surfaced as read-only "Coming soon" rows.
export const COMING_SOON_IDS: ReadonlySet<string> = new Set(COMING_SOON_MODULE_MANIFESTS.map((m) => m.id))

// Computed once: immutable for the session. Groups the active (toggleable)
// modules together with any "Coming soon" feature-flagged modules, by category.
// Active modules are listed before coming-soon ones within a category because
// they are added first.
export const MODULE_CATEGORY_GROUPS: Array<{ category: CapabilityCategory; manifests: CapabilityManifest[] }> =
  (() => {
    const groups = new Map<CapabilityCategory, CapabilityManifest[]>()
    for (const manifest of [...ACTIVE_RENDERER_MODULE_MANIFESTS, ...COMING_SOON_MODULE_MANIFESTS]) {
      const category = manifest.category ?? 'orchestration'
      const list = groups.get(category) ?? []
      list.push(manifest)
      groups.set(category, list)
    }
    return [...groups.entries()]
      .map(([category, manifests]) => ({ category, manifests }))
      .sort((a, b) => categoryRank(a.category) - categoryRank(b.category))
  })()
