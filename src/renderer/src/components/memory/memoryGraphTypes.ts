import type {
  MemoryGraphColorRule,
  MemoryGraphDisplayConfig,
  MemoryGraphFiltersConfig,
  MemoryGraphForcesConfig,
  MemoryGraphSettings,
} from '../../types/workspace'

export type SidebarTab = 'filters' | 'groups' | 'display' | 'forces'

export type Camera = {
  x: number
  y: number
  scale: number
}

export type PositionedNode = MemoryGraphNode & {
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null
  fy: number | null
  radius: number
  color: string
  visible: boolean
}

export const GRAPH_PALETTE = [
  '#818cf8',
  '#34d399',
  '#fbbf24',
  '#fb7185',
  '#22d3ee',
  '#c084fc',
  '#f472b6',
  '#a3e635',
  '#fb923c',
  '#60a5fa',
] as const

export const UNRESOLVED_COLOR = '#3f3f46'
export const DEFAULT_GROUP_COLOR = '#52525b'

export function ruleId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const DEFAULT_FILTERS: MemoryGraphFiltersConfig = {
  hideOrphans: false,
  hideAttachments: false,
  hideUnresolved: false,
  depthFromSelection: null,
  disabledGroups: [],
}

/** Bumped any time DEFAULT_DISPLAY or DEFAULT_FORCES move enough that we want
 *  untuned workspaces to inherit the new feel. Stored settings with a lower
 *  version trigger a one-shot upgrade in the panel. */
export const GRAPH_SETTINGS_VERSION = 2

export const DEFAULT_DISPLAY: MemoryGraphDisplayConfig = {
  nodeSizeScale: 1.5,
  lineThicknessScale: 1,
  labelFadeThreshold: 0.25,
  labelFontSize: 13,
  showArrows: false,
  curvedEdges: true,
  glowHalos: true,
  starfield: false,
}

export const DEFAULT_FORCES: MemoryGraphForcesConfig = {
  centerForce: 0.45,
  repelForce: 0.15,
  linkForce: 0.55,
  linkDistance: 42,
}

export const DEFAULT_GRAPH_SETTINGS: MemoryGraphSettings = {
  version: GRAPH_SETTINGS_VERSION,
  sidebarOpen: false,
  activeTab: 'filters',
  filters: DEFAULT_FILTERS,
  colorRules: [],
  display: DEFAULT_DISPLAY,
  forces: DEFAULT_FORCES,
}

export function colorForGroup(group: string, rules: MemoryGraphColorRule[]): string {
  for (const rule of rules) {
    const pattern = rule.pattern.replace(/^path:/i, '').replace(/^\/+/, '')
    if (!pattern) continue
    if (group === pattern || group.toLowerCase() === pattern.toLowerCase()) return rule.color
    const lower = group.toLowerCase()
    const patternLower = pattern.toLowerCase().replace(/\/+$/u, '')
    if (lower === patternLower) return rule.color
  }
  return DEFAULT_GROUP_COLOR
}

export function colorForRelativePath(
  relativePath: string,
  group: string,
  rules: MemoryGraphColorRule[]
): string {
  const path = relativePath.toLowerCase()
  for (const rule of rules) {
    const pattern = rule.pattern.toLowerCase().replace(/^path:/, '').replace(/^\/+/, '')
    if (!pattern) continue
    if (path === pattern || path.startsWith(`${pattern.replace(/\/+$/u, '')}/`)) {
      return rule.color
    }
  }
  return colorForGroup(group, rules)
}

export function normalizeFilters(
  input: Partial<MemoryGraphFiltersConfig> | null | undefined
): MemoryGraphFiltersConfig {
  const depth =
    typeof input?.depthFromSelection === 'number'
    && Number.isFinite(input.depthFromSelection)
    && input.depthFromSelection > 0
      ? Math.min(8, Math.round(input.depthFromSelection))
      : null
  const disabled = Array.isArray(input?.disabledGroups)
    ? input.disabledGroups.filter((value): value is string => typeof value === 'string')
    : []
  return {
    hideOrphans: Boolean(input?.hideOrphans),
    hideAttachments: Boolean(input?.hideAttachments),
    hideUnresolved: Boolean(input?.hideUnresolved),
    depthFromSelection: depth,
    disabledGroups: disabled,
  }
}

export function normalizeDisplay(
  input: Partial<MemoryGraphDisplayConfig> | null | undefined
): MemoryGraphDisplayConfig {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback
  return {
    nodeSizeScale: clamp(input?.nodeSizeScale, 0.5, 3, DEFAULT_DISPLAY.nodeSizeScale),
    lineThicknessScale: clamp(input?.lineThicknessScale, 0.5, 3, DEFAULT_DISPLAY.lineThicknessScale),
    labelFadeThreshold: clamp(input?.labelFadeThreshold, 0, 1.5, DEFAULT_DISPLAY.labelFadeThreshold),
    labelFontSize: clamp(input?.labelFontSize, 9, 18, DEFAULT_DISPLAY.labelFontSize),
    showArrows: Boolean(input?.showArrows),
    curvedEdges: input?.curvedEdges !== false,
    glowHalos: input?.glowHalos !== false,
    starfield: Boolean(input?.starfield),
  }
}

export function normalizeForces(
  input: Partial<MemoryGraphForcesConfig> | null | undefined
): MemoryGraphForcesConfig {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback
  return {
    centerForce: clamp(input?.centerForce, 0, 1, DEFAULT_FORCES.centerForce),
    repelForce: clamp(input?.repelForce, 0, 2, DEFAULT_FORCES.repelForce),
    linkForce: clamp(input?.linkForce, 0, 1, DEFAULT_FORCES.linkForce),
    linkDistance: clamp(input?.linkDistance, 20, 240, DEFAULT_FORCES.linkDistance),
  }
}

export function normalizeColorRules(
  input: unknown
): MemoryGraphColorRule[] {
  if (!Array.isArray(input)) return []
  return input
    .map((rule) => {
      if (!rule || typeof rule !== 'object') return null
      const r = rule as Partial<MemoryGraphColorRule>
      if (typeof r.pattern !== 'string' || !r.pattern.trim()) return null
      if (typeof r.color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(r.color)) return null
      return {
        id: typeof r.id === 'string' && r.id.trim() ? r.id : ruleId(),
        pattern: r.pattern.trim(),
        color: r.color,
      }
    })
    .filter((rule): rule is MemoryGraphColorRule => rule !== null)
}

export function normalizeGraphSettings(
  input: Partial<MemoryGraphSettings> | null | undefined
): MemoryGraphSettings {
  const tab: SidebarTab =
    input?.activeTab === 'groups'
    || input?.activeTab === 'display'
    || input?.activeTab === 'forces'
      ? input.activeTab
      : 'filters'
  const storedVersion = typeof input?.version === 'number' && input.version > 0 ? input.version : 0
  const needsLayoutMigration = storedVersion < GRAPH_SETTINGS_VERSION

  // When upgrading legacy settings, replace the layout-affecting numerics with
  // the current defaults but preserve user toggles (starfield, glow, arrows,
  // curved edges) and any explicit color rules / filter choices.
  const display = needsLayoutMigration
    ? {
        ...DEFAULT_DISPLAY,
        showArrows: Boolean(input?.display?.showArrows),
        curvedEdges: input?.display?.curvedEdges !== false,
        glowHalos: input?.display?.glowHalos !== false,
        starfield: Boolean(input?.display?.starfield),
      }
    : normalizeDisplay(input?.display)

  const forces = needsLayoutMigration ? { ...DEFAULT_FORCES } : normalizeForces(input?.forces)

  return {
    version: GRAPH_SETTINGS_VERSION,
    sidebarOpen: Boolean(input?.sidebarOpen),
    activeTab: tab,
    filters: normalizeFilters(input?.filters),
    colorRules: normalizeColorRules(input?.colorRules),
    display,
    forces,
  }
}
