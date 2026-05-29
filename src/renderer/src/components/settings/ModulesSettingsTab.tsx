import { BUNDLED_RENDERER_MODULE_MANIFESTS, selectModuleEnabled } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SettingToggle } from './SettingsAtoms'

// Capability-module chooser. Reads/writes the per-module enablement override in
// appSettings.modules; gating in the panel rail and the layout factory reacts to
// the same value. See future-plans/2026-05-28-feature-level-pluggable-architecture.md.
export function ModulesSettingsTab() {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)

  return (
    <div
      role="tabpanel"
      id="settings-panel-modules"
      aria-labelledby="settings-tab-modules"
      className="space-y-4"
    >
      <div className="text-sm font-semibold text-[color:var(--text-strong)]">
        Capability modules
      </div>
      <p className="text-[12px] leading-5 text-[color:var(--text-disabled)]">
        Turn features on or off. Disabled modules don&rsquo;t load their panels, keeping the app
        lighter. Some changes take effect on the next reload.
      </p>
      <div className="divide-y divide-[color:var(--border-subtle)]">
        {BUNDLED_RENDERER_MODULE_MANIFESTS.map((manifest) => (
          <SettingToggle
            key={manifest.id}
            label={manifest.displayName}
            description={manifest.summary}
            enabled={manifest.core ? true : selectModuleEnabled(overrides, manifest.id)}
            disabled={manifest.core}
            onChange={(next) => setModuleEnabled(manifest.id, next)}
          />
        ))}
      </div>
    </div>
  )
}
