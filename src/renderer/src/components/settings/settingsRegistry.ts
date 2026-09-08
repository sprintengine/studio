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
  SprintEngineCliPermissionPreset,
} from '../../types/workspace'
import { APP_THEMES, type AppTheme } from '../../types/appTheme'

// Scope marks where a field is surfaced:
// - 'app'   — app-wide preferences shown in SettingsPanel.
// - 'panel' — per-panel popover (Sprint Engine, Backlog).
// - 'role'  — per-agent-role defaults (specialist, sprint engine).
type SettingScope = 'app' | 'panel' | 'role'

type SelectOption<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
}

type SettingFieldText = {
  type: 'text'
  placeholder?: string
}

type SettingFieldMultiline = {
  type: 'multiline'
  placeholder?: string
  rows?: number
}

type SettingFieldNumber = {
  type: 'number'
  min?: number
  max?: number
  step?: number
}

type SettingFieldSwitch = {
  type: 'switch'
}

type SettingFieldSelect<V extends string = string> = {
  type: 'select'
  items: ReadonlyArray<SelectOption<V>>
}

type SettingField =
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
  // Example: 'appSettings.keepRunningInBackground'.
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
  { value: 'none', label: 'None — pass no flag, let the CLI decide' },
  { value: 'manual', label: 'Manual — ask before every action' },
  { value: 'auto', label: 'Auto — the CLI reviews each action instead of you' },
  { value: 'bypass', label: 'Bypass all — no permission checks' },
]

const APP_THEME_OPTIONS: ReadonlyArray<SelectOption<AppTheme>> = APP_THEMES.map(
  (t) => ({ value: t.id, label: t.label }),
)

const settingsRegistry: ReadonlyArray<SettingDescriptor> = [
  // Appearance — app-wide theme.
  {
    id: 'appearance-theme',
    label: 'Theme',
    scope: 'app',
    group: 'appearance',
    field: { type: 'select', items: APP_THEME_OPTIONS },
    storePath: 'appSettings.appearance.theme',
    storeSetter: 'setAppearanceTheme',
  },

  // Background mode — whether the process outlives its last window (MC-2156).
  {
    id: 'keep-running-in-background',
    label: 'Keep running when the last window closes',
    help: 'Sprints and automations keep working with no window open.',
    scope: 'app',
    group: 'background',
    field: { type: 'switch' },
    storePath: 'appSettings.keepRunningInBackground',
    storeSetter: 'setKeepRunningInBackground',
  },

  // Agent runtime defaults.
  {
    id: 'last-selected-cli',
    label: 'Default CLI runtime',
    help: 'For new agents with no CLI chosen.',
    scope: 'app',
    group: 'agents',
    field: { type: 'select', items: CLI_OPTIONS },
    storePath: 'appSettings.lastSelectedCli',
    storeSetter: 'setLastSelectedCli',
  },
  {
    id: 'last-agent-spawn-permission-preset',
    label: 'Default agent permission preset',
    help: 'For new agents and sprint runs.',
    scope: 'app',
    group: 'agents',
    field: { type: 'select', items: PERMISSION_PRESET_OPTIONS },
    storePath: 'appSettings.lastAgentSpawnPermissionPreset',
    storeSetter: 'setLastAgentSpawnPermissionPreset',
  },
  {
    id: 'terminal-idle-suspend-minutes',
    label: 'Pause idle terminals after',
    help: 'Minutes. Paused terminals keep their screen and resume on click.',
    scope: 'app',
    group: 'agents',
    field: { type: 'number', min: 1, max: 1440, step: 1 },
    storePath: 'appSettings.terminalIdleSuspendMinutes',
    storeSetter: 'setTerminalIdleSuspendMinutes',
  },
  {
    id: 'terminal-keep-recent-alive',
    label: 'Always keep running',
    help: 'The most recent terminals that are never paused.',
    scope: 'app',
    group: 'agents',
    field: { type: 'number', min: 0, max: 20, step: 1 },
    storePath: 'appSettings.terminalKeepRecentAlive',
    storeSetter: 'setTerminalKeepRecentAlive',
  },
  // Learn center — tips startup toggle.
  {
    id: 'learning-show-tips-on-startup',
    label: 'Show tips on startup',
    help: 'One tip, the first time the app opens each day.',
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
