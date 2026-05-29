import type { CapabilityCategory, CapabilityManifest, ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { MODULE_PROFILES, type ModuleProfileId } from '../../../../shared/modules/profiles'
import { BUNDLED_RENDERER_MODULE_MANIFESTS, matchModuleProfile, selectModuleEnabled } from '../../modules'
import { FOCUS_RING_CLASS } from '../ui'
import { SettingToggle } from './SettingsAtoms'

// Shared capability-module controls composed by both the Settings → Modules
// manager and the first-run chooser: a profile picker and a category-grouped
// toggle list. Keeping them here means the two surfaces stay identical.

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

function manifestsByCategory(): Array<{ category: CapabilityCategory; manifests: CapabilityManifest[] }> {
  const groups = new Map<CapabilityCategory, CapabilityManifest[]>()
  for (const manifest of BUNDLED_RENDERER_MODULE_MANIFESTS) {
    const category = manifest.category ?? 'orchestration'
    const list = groups.get(category) ?? []
    list.push(manifest)
    groups.set(category, list)
  }
  return [...groups.entries()]
    .map(([category, manifests]) => ({ category, manifests }))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category))
}

export function ModuleProfilePicker({
  overrides,
  onApply,
}: {
  overrides: ModuleEnablementOverrides
  onApply: (profileId: ModuleProfileId) => void
}) {
  const active = matchModuleProfile(overrides)
  return (
    <div role="radiogroup" aria-label="Module profiles" className="flex flex-col gap-1.5">
      {MODULE_PROFILES.map((profile) => {
        const selected = active === profile.id
        return (
          <button
            key={profile.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onApply(profile.id)}
            className={`flex flex-col items-start gap-0.5 rounded-[var(--radius-sm)] border-l-2 px-3 py-2 text-left transition-colors ${FOCUS_RING_CLASS} ${
              selected
                ? 'border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
                : 'border-l-transparent bg-transparent hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            <span className="text-sm font-medium text-[color:var(--text-strong)]">{profile.name}</span>
            <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">{profile.summary}</span>
          </button>
        )
      })}
      <button
        type="button"
        role="radio"
        aria-checked={active === null}
        disabled
        tabIndex={-1}
        className="flex flex-col items-start gap-0.5 px-3 py-1 text-left"
      >
        <span className="text-[12px] leading-5 text-[color:var(--text-subtle)]">
          {active === null ? 'Custom selection' : 'Adjust any module below for a custom selection.'}
        </span>
      </button>
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
      {manifestsByCategory().map(({ category, manifests }) => (
        <div key={category} className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-[color:var(--text-subtle)]">
            {CATEGORY_LABEL[category] ?? category}
          </div>
          <div className="divide-y divide-[color:var(--border-subtle)]">
            {manifests.map((manifest) => (
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
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
