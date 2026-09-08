import { selectModuleEnabled } from '../../modules'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'

// Leading-icon accent for a workspace panel tab, gated by module enablement: the
// tool identity color when the owning module is enabled, the muted default when
// it is off (AC4 tab degradation).
export type PanelTabAccentKind = 'sprintengine'

const PANEL_TAB_ACCENT: Record<PanelTabAccentKind, { moduleId: string; enabledClass: string }> = {
  sprintengine: { moduleId: 'sprint-engine', enabledClass: 'text-[color:var(--tool-sprintengine)]' },
}

export function panelTabAccentClass(kind: PanelTabAccentKind, moduleOverrides: ModuleEnablementOverrides): string {
  const { moduleId, enabledClass } = PANEL_TAB_ACCENT[kind]
  return selectModuleEnabled(moduleOverrides, moduleId) ? enabledClass : 'text-[color:var(--text-muted)]'
}
