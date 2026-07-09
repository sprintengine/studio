// settingsRegistry — single typed source of truth for application-level
// settings fields. Read by T18 (SettingsPanel rewrite), T19 (MobileSettingsTab
// and the per-panel popovers) so the same field shows up with the same label,
// help text, and field shape everywhere.
//
// Design contract:
// - The registry is pure data: descriptors only, no live read/write closures.
//   Consumers wire `storePath` and `storeSetter` to the workspace store at
//   render time.
// - No new persistence layer. Every entry points at an existing slice of
//   `appSettings` in `useWorkspaceStore` (or, for non-store settings, at the
//   IPC route via `writeVia`).
// - Field shapes are bounded by the five primitives the redesign ships:
//   text, multiline, number, switch, select. Adding a sixth requires a
//   matching ui/<Primitive> with a documented keyboard contract.
// - Compound settings (per-CLI runtime forms, per-server MCP forms,
//   per-workspace knowledge-root inputs) are intentionally *not* expressed
//   here; they are rendered by their existing bespoke components.
//   T18/T19 still consume those components directly.

import type {
  AgentCli,
  MultiloopRole,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
} from '../../types/workspace'
import { APP_THEMES, type AppTheme } from '../../types/appTheme'

// Scope marks where a field is surfaced:
// - 'app'   — app-wide preferences shown in SettingsPanel.
// - 'panel' — per-panel popover (Switchboard, Watchtower, Sprint Engine).
// - 'role'  — per-agent-role defaults (specialist, multiloop, sprint engine).
export type SettingScope = 'app' | 'panel' | 'role'

export type SelectOption<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
}

export type SettingFieldText = {
  type: 'text'
  placeholder?: string
}

export type SettingFieldMultiline = {
  type: 'multiline'
  placeholder?: string
  rows?: number
}

export type SettingFieldNumber = {
  type: 'number'
  min?: number
  max?: number
  step?: number
}

export type SettingFieldSwitch = {
  type: 'switch'
}

export type SettingFieldSelect<V extends string = string> = {
  type: 'select'
  items: ReadonlyArray<SelectOption<V>>
}

export type SettingField =
  | SettingFieldText
  | SettingFieldMultiline
  | SettingFieldNumber
  | SettingFieldSwitch
  | SettingFieldSelect

export type SettingDescriptor = {
  // Stable id; consumers use this as React key + htmlFor / aria-controls link.
  id: string
  label: string
  // Sentence-case help. Rendered through Field's `help` slot.
  help?: string
  scope: SettingScope
  // Settings tab / popover group this field belongs to.
  group: string
  field: SettingField
  // Dot-path inside `useWorkspaceStore` for the canonical read source.
  // Example: 'appSettings.usageTelemetry.sendUsageData'.
  storePath: string
  // Workspace-store action that mutates the value when the store owns the
  // write path. Some settings live outside the store — for those leave
  // `storeSetter` undefined and document the write route via `writeVia`.
  storeSetter?: string
  // Free-form pointer to the write route for non-store settings — IPC
  // method, service call, or persisted document. Display-only.
  writeVia?: string
}

const CLI_OPTIONS: ReadonlyArray<SelectOption<AgentCli>> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
]

const PERMISSION_PRESET_OPTIONS: ReadonlyArray<
  SelectOption<SprintEngineCliPermissionPreset>
> = [
  { value: 'default', label: 'Default — ask each time' },
  { value: 'auto_workspace', label: 'Auto in workspace — skip prompts inside this workspace' },
  { value: 'bypass_all', label: 'Bypass all — accept every prompt' },
]

const SPECIALIST_OPTIONS: ReadonlyArray<SelectOption<SpecialistActionId>> = [
  { value: 'architect', label: 'Architect' },
  { value: 'product-strategist', label: 'Product strategist' },
  { value: 'developer', label: 'Developer' },
  { value: 'devops-infra', label: 'DevOps / infrastructure' },
  { value: 'performance', label: 'Performance' },
  { value: 'production-readiness-review', label: 'Production readiness' },
  { value: 'cross-platform', label: 'Cross-platform compatibility' },
  { value: 'blog-writer', label: 'Blog writer' },
  { value: 'qa-test', label: 'QA / test' },
  { value: 'security-review', label: 'Security review' },
  { value: 'frontend-design-review', label: 'Frontend designer' },
  { value: 'ui-ux-review', label: 'UI/UX review' },
]

const APP_THEME_OPTIONS: ReadonlyArray<SelectOption<AppTheme>> = APP_THEMES.map(
  (t) => ({ value: t.id, label: t.label }),
)

const MULTILOOP_ROLE_OPTIONS: ReadonlyArray<SelectOption<MultiloopRole>> = [
  { value: 'coordinator', label: 'Coordinator' },
  { value: 'architect', label: 'Architect' },
  { value: 'product', label: 'Product' },
  { value: 'developer', label: 'Developer' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'tester', label: 'Tester' },
  { value: 'security', label: 'Security' },
  { value: 'performance', label: 'Performance' },
  { value: 'cross_platform', label: 'Cross-platform' },
]

export const settingsRegistry: ReadonlyArray<SettingDescriptor> = [
  // Appearance — app-wide theme.
  {
    id: 'appearance-theme',
    label: 'Theme',
    help: 'Theme applies across every Multicode workspace and panel.',
    scope: 'app',
    group: 'appearance',
    field: { type: 'select', items: APP_THEME_OPTIONS },
    storePath: 'appSettings.appearance.theme',
    storeSetter: 'setAppearanceTheme',
  },

  // Telemetry — anonymous usage + crash diagnostics.
  {
    id: 'usage-telemetry-send-data',
    label: 'Send anonymous usage data',
    help: 'Reports feature usage counts. No file contents, no terminal output.',
    scope: 'app',
    group: 'telemetry',
    field: { type: 'switch' },
    storePath: 'appSettings.usageTelemetry.sendUsageData',
    storeSetter: 'setUsageTelemetrySettings',
  },
  {
    id: 'usage-telemetry-local-export',
    label: 'Export usage data to a local file',
    help: 'Writes a daily local JSON export of usage events for self-review.',
    scope: 'app',
    group: 'telemetry',
    field: { type: 'switch' },
    storePath: 'appSettings.usageTelemetry.localDevExportEnabled',
    storeSetter: 'setUsageTelemetrySettings',
  },
  {
    id: 'usage-telemetry-export-diagnostics',
    label: 'Include diagnostic logs in exports',
    help: 'When the local export is on, also include diagnostic events for support sessions.',
    scope: 'app',
    group: 'telemetry',
    field: { type: 'switch' },
    storePath: 'appSettings.usageTelemetry.exportDiagnostics',
    storeSetter: 'setUsageTelemetrySettings',
  },

  // Agent runtime defaults.
  {
    id: 'last-selected-cli',
    label: 'Default CLI runtime',
    help: 'Used when spawning a new agent without an explicit CLI override.',
    scope: 'app',
    group: 'agents',
    field: { type: 'select', items: CLI_OPTIONS },
    storePath: 'appSettings.lastSelectedCli',
    storeSetter: 'setLastSelectedCli',
  },
  {
    id: 'last-agent-spawn-permission-preset',
    label: 'Default agent permission preset',
    help: 'Permission mode used for new agent spawns and as the initial default for sprint runs without a local override.',
    scope: 'app',
    group: 'agents',
    field: { type: 'select', items: PERMISSION_PRESET_OPTIONS },
    storePath: 'appSettings.lastAgentSpawnPermissionPreset',
    storeSetter: 'setLastAgentSpawnPermissionPreset',
  },
  {
    id: 'terminal-idle-suspend-minutes',
    label: 'Pause idle terminals after',
    help: 'Minutes an unused agent terminal sits before it is paused to free memory. Its painted view is kept and resumes the instant you click or type. Agents waiting on you or mid-work are never paused.',
    scope: 'app',
    group: 'agents',
    field: { type: 'number', min: 1, max: 1440, step: 1 },
    storePath: 'appSettings.terminalIdleSuspendMinutes',
    storeSetter: 'setTerminalIdleSuspendMinutes',
  },
  {
    id: 'terminal-keep-recent-alive',
    label: 'Always keep running',
    help: 'Number of most recently used agent terminals that are never paused, even when idle. Set to 0 to allow pausing every idle terminal.',
    scope: 'app',
    group: 'agents',
    field: { type: 'number', min: 0, max: 20, step: 1 },
    storePath: 'appSettings.terminalKeepRecentAlive',
    storeSetter: 'setTerminalKeepRecentAlive',
  },
  {
    id: 'guided-brief-conversation-sessions',
    label: 'Design Wizard chat sessions',
    help: 'Run Design Wizard specialists on Claude as chat sessions with clickable question cards. Turn off to use raw terminals for every wizard role.',
    scope: 'app',
    group: 'agents',
    field: { type: 'switch' },
    storePath: 'appSettings.guidedBriefConversationSessions',
    storeSetter: 'setGuidedBriefConversationSessions',
  },
  {
    id: 'last-selected-specialist',
    label: 'Default specialist action',
    help: 'Preselected specialist when running a one-off task from the palette.',
    scope: 'role',
    group: 'agents',
    field: { type: 'select', items: SPECIALIST_OPTIONS },
    storePath: 'appSettings.lastSelectedSpecialist',
    storeSetter: 'setLastSelectedSpecialist',
  },
  {
    id: 'last-selected-multiloop-role',
    label: 'Default Multiloop role',
    help: 'Preselected role when spawning a Multiloop agent.',
    scope: 'role',
    group: 'agents',
    field: { type: 'select', items: MULTILOOP_ROLE_OPTIONS },
    storePath: 'appSettings.lastSelectedMultiloopRole',
    storeSetter: 'setLastSelectedMultiloopRole',
  },

  // Learn center — tips startup toggle.
  {
    id: 'learning-show-tips-on-startup',
    label: 'Show tips on startup',
    help: 'When on, a tip dialog appears the first time the app opens each day.',
    scope: 'app',
    group: 'learn',
    field: { type: 'switch' },
    storePath: 'appSettings.learning.showTipsOnStartup',
    storeSetter: 'setLearningShowTipsOnStartup',
  },
] as const

// Convenience views over the registry.
export function getSettingDescriptor(id: string): SettingDescriptor | undefined {
  return settingsRegistry.find((entry) => entry.id === id)
}

export function getSettingsByGroup(group: string): ReadonlyArray<SettingDescriptor> {
  return settingsRegistry.filter((entry) => entry.group === group)
}

export function getSettingsByScope(scope: SettingScope): ReadonlyArray<SettingDescriptor> {
  return settingsRegistry.filter((entry) => entry.scope === scope)
}
