import { useWorkspaceStore } from '../../store/workspaceStore'
import { ModuleToggleList } from './ModuleControls'
import { ThirdPartyModuleList } from './ThirdPartyModuleList'

// Module manager: a category-grouped toggle list. Reads/writes the per-module
// enablement override in appSettings.modules; gating in the panel rail and the
// layout factory react to the same value.
export function ModulesSettingsTab() {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)

  return (
    <div
      role="tabpanel"
      id="settings-panel-modules"
      aria-labelledby="settings-tab-modules"
      className="space-y-5"
    >
      <ModuleToggleList overrides={overrides} onToggle={setModuleEnabled} />

      <ThirdPartyModuleList overrides={overrides} onSetEnabled={setModuleEnabled} />
    </div>
  )
}
