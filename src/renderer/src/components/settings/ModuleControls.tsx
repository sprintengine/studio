import type { CapabilityCategory, CapabilityManifest, ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { ACTIVE_RENDERER_MODULE_MANIFESTS, COMING_SOON_MODULE_MANIFESTS, selectModuleEnabled } from '../../modules'
import { Badge } from '../ui'
import { SettingToggle } from './SettingsAtoms'

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
// everyday wording over internal category ids — e.g. "Agents & workflows" rather
// than the raw "orchestration".
const CATEGORY_LABEL: Record<string, string> = {
  core: 'Core',
  'dev-tools': 'Dev tools',
  vcs: 'Version control',
  orchestration: 'Agents & workflows',
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

// Manifest lookup for resolving a module's `dependsOn` labels.
const MANIFEST_BY_ID: ReadonlyMap<string, CapabilityManifest> = new Map(
  ACTIVE_RENDERER_MODULE_MANIFESTS.map((manifest) => [manifest.id, manifest]),
)

// The display name of the first prerequisite a module still needs — a non-core
// dependency (agent-runtime is always on) that is not currently enabled. When
// present the row is disabled and shows "Needs <name>" (e.g. Roadmap needs Sprint
// Engine), mirroring the resolver's `disabled_dependency` so the reason is visible
// rather than the toggle silently refusing to stick.
function unmetDependencyName(
  manifest: CapabilityManifest,
  overrides: ModuleEnablementOverrides,
): string | null {
  for (const depId of manifest.dependsOn ?? []) {
    const dependency = MANIFEST_BY_ID.get(depId)
    if (!dependency || dependency.core) continue
    if (!selectModuleEnabled(overrides, depId)) return dependency.displayName
  }
  return null
}

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

// Read-only row for a feature-flagged module: greyed out, with a "Coming soon"
// pill in place of the toggle. The module is absent from the enablement
// universe, so there is nothing to turn on — the row is purely informational.
function ComingSoonModuleRow({ manifest }: { manifest: CapabilityManifest }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 opacity-60">
      <div className="min-w-0">
        <div className="text-body font-medium text-[color:var(--text-subtle)]">{manifest.displayName}</div>
        {manifest.summary ? (
          <div className="mt-0.5 text-body leading-5 text-[color:var(--text-disabled)]">
            {manifest.summary}
          </div>
        ) : null}
      </div>
      <Badge decorative className="mt-0.5 shrink-0 whitespace-nowrap">
        Coming soon
      </Badge>
    </div>
  )
}

export function ModuleToggleList({
  overrides,
  onToggle,
}: {
  overrides: ModuleEnablementOverrides
  onToggle: (moduleId: string, enabled: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      {MODULE_CATEGORY_GROUPS.map(({ category, manifests }) => (
        <div key={category} className="flex flex-col gap-1">
          <div className="text-meta font-medium text-[color:var(--text-subtle)]">
            {categoryLabel(category)}
          </div>
          <div className="divide-y divide-[color:var(--border-subtle)]">
            {manifests.map((manifest) =>
              COMING_SOON_IDS.has(manifest.id) ? (
                <ComingSoonModuleRow key={manifest.id} manifest={manifest} />
              ) : (
                (() => {
                  const missingDependency = manifest.core ? null : unmetDependencyName(manifest, overrides)
                  return (
                    <SettingToggle
                      key={manifest.id}
                      label={manifest.displayName}
                      description={
                        manifest.core ? `${manifest.summary ?? ''} Always on.`.trim() : manifest.summary
                      }
                      requirement={missingDependency ? `Needs ${missingDependency}` : undefined}
                      enabled={manifest.core ? true : selectModuleEnabled(overrides, manifest.id)}
                      disabled={manifest.core || Boolean(missingDependency)}
                      onChange={(next) => onToggle(manifest.id, next)}
                    />
                  )
                })()
              )
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
