import type { CapabilityCategory, CapabilityManifest, ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { ACTIVE_RENDERER_MODULE_MANIFESTS, COMING_SOON_MODULE_MANIFESTS, selectModuleEnabled } from '../../modules'
import { SettingToggle } from './SettingsAtoms'

// Shared capability-module controls composed by both the Settings → Modules
// manager and the first-run chooser: a category-grouped toggle list, plus any
// feature-flagged modules shown as greyed-out "Coming soon" rows. Keeping them
// here means the two surfaces stay identical.

const CATEGORY_ORDER: CapabilityCategory[] = [
  'core',
  'dev-tools',
  'vcs',
  'orchestration',
  'insight',
  'connectivity',
]

const CATEGORY_LABEL: Record<string, string> = {
  core: 'Core',
  'dev-tools': 'Dev tools',
  vcs: 'Version control',
  orchestration: 'Orchestration',
  insight: 'Insight',
  connectivity: 'Connectivity',
}

function categoryRank(category: CapabilityCategory | undefined): number {
  const index = CATEGORY_ORDER.indexOf(category ?? 'orchestration')
  return index === -1 ? CATEGORY_ORDER.length : index
}

// Ids of the feature-flagged modules surfaced as read-only "Coming soon" rows.
const COMING_SOON_IDS: ReadonlySet<string> = new Set(COMING_SOON_MODULE_MANIFESTS.map((m) => m.id))

// Computed once: immutable for the session. Groups the active (toggleable)
// modules together with any "Coming soon" feature-flagged modules, by category.
// Active modules are listed before coming-soon ones within a category because
// they are added first.
const MODULE_CATEGORY_GROUPS: Array<{ category: CapabilityCategory; manifests: CapabilityManifest[] }> =
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
        <div className="text-[13px] font-medium text-[color:var(--text-subtle)]">{manifest.displayName}</div>
        {manifest.summary ? (
          <div className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-disabled)]">
            {manifest.summary}
          </div>
        ) : null}
      </div>
      <span className="mt-0.5 shrink-0 whitespace-nowrap rounded-full border border-[color:var(--border-default)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-subtle)]">
        Coming soon
      </span>
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
          <div className="text-[11px] font-medium text-[color:var(--text-subtle)]">
            {CATEGORY_LABEL[category] ?? category}
          </div>
          <div className="divide-y divide-[color:var(--border-subtle)]">
            {manifests.map((manifest) =>
              COMING_SOON_IDS.has(manifest.id) ? (
                <ComingSoonModuleRow key={manifest.id} manifest={manifest} />
              ) : (
                <SettingToggle
                  key={manifest.id}
                  label={manifest.displayName}
                  description={
                    manifest.core ? `${manifest.summary ?? ''} Always on.`.trim() : manifest.summary
                  }
                  enabled={manifest.core ? true : selectModuleEnabled(overrides, manifest.id)}
                  disabled={manifest.core}
                  onChange={(next) => onToggle(manifest.id, next)}
                />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
