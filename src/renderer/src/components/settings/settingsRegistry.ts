// settingsRegistry — the typed descriptors for the application-level settings
// fields that more than one surface would otherwise spell for itself: label,
// help text, and field shape in one place.
//
// It holds ONLY fields a consumer actually fetches. Four descriptors nothing
// ever asked for — appearance-theme, last-selected-cli,
// last-agent-spawn-permission-preset, learning-show-tips-on-startup — were
// deleted on 2026-09-08: SettingsPanel renders those controls directly, and a
// descriptor no one reads is a second spelling that can drift from the one on
// screen. Add one back when a second surface needs the same field.
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

const settingsRegistry: ReadonlyArray<SettingDescriptor> = [
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

  // Product telemetry. Grouped with background mode rather than given a tab of
  // its own: both are app-wide switches about what the process does when you
  // are not looking at it.
  {
    id: 'telemetry-enabled',
    label: 'Share anonymous usage data',
    help: 'Counts and timings only — never your prompts, code, file paths, or project names.',
    scope: 'app',
    group: 'background',
    field: { type: 'switch' },
    storePath: 'appSettings.telemetryEnabled',
    storeSetter: 'setTelemetryEnabled',
  },

  // Agent runtime defaults.
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
] as const

// Convenience views over the registry.
export function getSettingDescriptor(id: string): SettingDescriptor | undefined {
  return settingsRegistry.find((entry) => entry.id === id)
}
