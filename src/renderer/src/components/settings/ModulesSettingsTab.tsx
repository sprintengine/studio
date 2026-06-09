import { useWorkspaceStore } from '../../store/workspaceStore'
import { ModuleProfilePicker, ModuleToggleList } from './ModuleControls'
import { ThirdPartyModuleList } from './ThirdPartyModuleList'

// Capability-module manager. A profile picker for one-click setups plus a
// category-grouped toggle list. Reads/writes the per-module enablement override
// in appSettings.modules; gating in the panel rail and the layout factory react
// to the same value. See future-plans/2026-05-28-feature-level-pluggable-architecture.md.
export function ModulesSettingsTab() {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)
  const applyModuleProfile = useWorkspaceStore((state) => state.applyModuleProfile)

  return (
    <div
      role="tabpanel"
      id="settings-panel-modules"
      aria-labelledby="settings-tab-modules"
      className="space-y-5"
    >
      <div>
        <div className="text-sm font-semibold text-[color:var(--text-strong)]">Capability modules</div>
        <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-disabled)]">
          Turn features on or off. Disabled modules don&rsquo;t load their panels, keeping the app
          lighter. Some changes take effect on the next reload.
        </p>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium text-[color:var(--text-subtle)]">Profiles</div>
        <ModuleProfilePicker overrides={overrides} onApply={applyModuleProfile} />
      </div>

      <ModuleToggleList overrides={overrides} onToggle={setModuleEnabled} />

      <ThirdPartyModuleList overrides={overrides} onSetEnabled={setModuleEnabled} />
    </div>
  )
}
