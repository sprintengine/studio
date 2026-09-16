import { selectModuleEnabled } from '../../modules'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { SPRINT_ENGINE_WORKSPACE_TYPE_ID } from '../../../../shared/sprintengine/workspace-record'

// Leading-icon accent for a workspace panel tab, gated by module enablement: the
// tool identity color when the owning module is enabled, the muted default when
// it is off (AC4 tab degradation).
// Keyed by the panel's component id, which for a module-owned board is the
// module's registered workspace type id — never a mode enum the shell compiles
// in (MC-2577).
export type PanelTabAccentKind = typeof SPRINT_ENGINE_WORKSPACE_TYPE_ID

const PANEL_TAB_ACCENT: Record<PanelTabAccentKind, { moduleId: string; enabledClass: string }> = {
  [SPRINT_ENGINE_WORKSPACE_TYPE_ID]: {
    moduleId: 'sprint-engine',
    enabledClass: 'text-[color:var(--tool-sprintengine)]',
  },
}

export function panelTabAccentClass(kind: PanelTabAccentKind, moduleOverrides: ModuleEnablementOverrides): string {
  const { moduleId, enabledClass } = PANEL_TAB_ACCENT[kind]
  return selectModuleEnabled(moduleOverrides, moduleId) ? enabledClass : 'text-[color:var(--text-muted)]'
}
