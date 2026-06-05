// Shortcuts settings tab. A searchable, grouped editor over the T1 command
// registry and the T2 persisted keybinding settings. The tab reads effective
// bindings (override ?? registry default) rather than hardcoded display
// strings, records new chords through the T1 parser, and surfaces same-scope
// conflicts inline.
//
// The view-model helpers below are pure and exported so the focused test can
// cover search, conflict text, disable/reset, and recorder key parsing without
// a DOM. The component wires them to the workspace store and the recorder.
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  COMMAND_REGISTRY,
  collapseDuplicateKeybindings,
  findKeybindingConflicts,
  keyFromEvent,
  normalizeKeybinding,
  renderKeybinding,
  type CommandCategory,
  type CommandDefinition,
  type CommandId,
  type CommandScope,
  type KeybindingConflict,
  type KeybindingConflictCandidate,
  type KeybindingPlatform,
} from '../../commands'
import type { KeybindingSettings } from '../../types/workspace'
import { GhostButton, InboxSearchInput, KbdChord, Section, StatusDot, Switch, Tooltip } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'

// --- View model (pure, exported for tests) ---------------------------------

export type ShortcutRow = {
  id: CommandId
  title: string
  category: CommandCategory
  scopes: readonly CommandScope[]
  /** Canonical registry defaults. */
  defaults: string[]
  /** Canonical user override, or null when none is persisted. */
  overrides: string[] | null
  disabled: boolean
  /** What actually fires: [] when disabled, else override ?? defaults. */
  effective: string[]
  /** Has a persisted override or disable flag. */
  customized: boolean
}

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  settings: 'Settings',
  command_palette: 'Command palette',
  workspace: 'Workspace',
  panel: 'Panels',
  specialist: 'Specialists',
  voice: 'Voice',
  editor: 'Editor',
  sprintengine: 'Sprint Engine',
  multiloop: 'Multiloop',
  watchtower: 'Watchtower',
  switchboard: 'Switchboard',
  git: 'Git',
  terminal: 'Terminal',
}

export function categoryLabel(category: CommandCategory): string {
  return CATEGORY_LABELS[category] ?? category
}

export function buildShortcutRows(
  commands: readonly CommandDefinition[],
  keybindings: KeybindingSettings,
): ShortcutRow[] {
  return commands.map((def) => {
    const defaults = collapseDuplicateKeybindings(def.defaultKeybindings ?? [])
    const rawOverride = keybindings.overrides[def.id]
    const collapsedOverride = Array.isArray(rawOverride) ? collapseDuplicateKeybindings(rawOverride) : []
    const overrides = collapsedOverride.length > 0 ? collapsedOverride : null
    const disabled = keybindings.disabled[def.id] === true
    const effective = disabled ? [] : overrides ?? defaults
    return {
      id: def.id as CommandId,
      title: def.title,
      category: def.category,
      scopes: def.scopes,
      defaults,
      overrides,
      disabled,
      effective,
      customized: Boolean(overrides) || disabled,
    }
  })
}

function toCandidate(row: ShortcutRow): KeybindingConflictCandidate {
  return { commandId: row.id, commandTitle: row.title, keybindings: row.effective, scopes: row.scopes }
}

/** Conflicts keyed by command id. Disabled rows contribute no bindings, so
 *  disabling a command clears its conflicts. */
export function computeConflicts(rows: readonly ShortcutRow[]): Map<string, KeybindingConflict[]> {
  const candidates = rows.map(toCandidate)
  const byId = new Map<string, KeybindingConflict[]>()
  for (const candidate of candidates) {
    const conflicts = findKeybindingConflicts(candidate, candidates)
    if (conflicts.length > 0) byId.set(candidate.commandId, conflicts)
  }
  return byId
}

/** Short, color-independent conflict sentence that names the other command. */
export function conflictMessage(conflicts: readonly KeybindingConflict[]): string | null {
  if (conflicts.length === 0) return null
  const blocking = conflicts.find((conflict) => conflict.severity === 'blocking')
  const primary = blocking ?? conflicts[0]
  const extra = conflicts.length - 1
  const suffix = extra > 0 ? ` and ${extra} more` : ''
  const lead = primary.severity === 'blocking' ? 'Conflicts with' : 'Also set in'
  return `${lead} ${primary.conflictingCommandTitle}${suffix}`
}

export function conflictTone(conflicts: readonly KeybindingConflict[]): 'error' | 'warn' | null {
  if (conflicts.length === 0) return null
  return conflicts.some((conflict) => conflict.severity === 'blocking') ? 'error' : 'warn'
}

export function rowMatchesQuery(row: ShortcutRow, query: string, platform: KeybindingPlatform): boolean {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return true
  const rendered = [...row.effective, ...row.defaults].map((chord) => renderKeybinding(chord, platform))
  const haystack = [row.title, categoryLabel(row.category), ...row.effective, ...row.defaults, ...rendered]
    .join(' ')
    .toLowerCase()
  return haystack.includes(trimmed)
}

export type ShortcutGroup = { category: CommandCategory; label: string; rows: ShortcutRow[] }

/** Group rows by category, preserving the order categories first appear in. */
export function groupRows(rows: readonly ShortcutRow[]): ShortcutGroup[] {
  const groups: ShortcutGroup[] = []
  const index = new Map<CommandCategory, ShortcutGroup>()
  for (const row of rows) {
    let group = index.get(row.category)
    if (!group) {
      group = { category: row.category, label: categoryLabel(row.category), rows: [] }
      index.set(row.category, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

const RECORDER_IGNORED_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'Dead', 'Unidentified'])

export type RecorderKeyEvent = {
  key: string
  /** Physical key code (e.g. `Slash`). Used for the key identity so it matches
   *  the dispatcher, which normalizes off `code` rather than the shifted key. */
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Convert a recorder keydown into a canonical chord, or null when the press is
 * a lone modifier / unparseable. The key identity comes from the dispatcher's
 * `keyFromEvent` (physical `code`), so e.g. Shift+/ records as `shift+/` and
 * resolves at dispatch instead of saving the unmatched shifted char `?`. The
 * platform's primary accelerator (Cmd on macOS, Ctrl elsewhere) maps to the
 * abstract `Primary` modifier so recorded chords match the registry convention
 * and conflict detection works cross-OS.
 */
export function eventToChordString(event: RecorderKeyEvent, platform: KeybindingPlatform): string | null {
  if (RECORDER_IGNORED_KEYS.has(event.key)) return null
  const modifiers: string[] = []
  if (platform === 'darwin') {
    if (event.metaKey) modifiers.push('Primary')
    if (event.ctrlKey) modifiers.push('Ctrl')
  } else {
    if (event.ctrlKey) modifiers.push('Primary')
    if (event.metaKey) modifiers.push('Meta')
  }
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  const keyToken = keyFromEvent(event)
  if (!keyToken) return null
  return normalizeKeybinding([...modifiers, keyToken].join('+'))
}

export function resolvePlatform(): KeybindingPlatform {
  const platform = typeof window !== 'undefined' ? window.api?.platform : undefined
  if (platform === 'darwin') return 'darwin'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

// --- Component -------------------------------------------------------------

export function KeyboardShortcutsTab() {
  const overrides = useWorkspaceStore((s) => s.appSettings.keybindings.overrides)
  const disabled = useWorkspaceStore((s) => s.appSettings.keybindings.disabled)
  const setCommandKeybindings = useWorkspaceStore((s) => s.setCommandKeybindings)
  const setCommandKeybindingDisabled = useWorkspaceStore((s) => s.setCommandKeybindingDisabled)
  const resetCommandKeybindings = useWorkspaceStore((s) => s.resetCommandKeybindings)
  const resetAllKeybindings = useWorkspaceStore((s) => s.resetAllKeybindings)
  const dialog = useConfirmDialog()

  const platform = useMemo(resolvePlatform, [])
  const [query, setQuery] = useState('')
  const [recordingId, setRecordingId] = useState<CommandId | null>(null)

  const keybindings = useMemo<KeybindingSettings>(() => ({ overrides, disabled }), [overrides, disabled])
  const rows = useMemo(() => buildShortcutRows(COMMAND_REGISTRY, keybindings), [keybindings])
  const conflicts = useMemo(() => computeConflicts(rows), [rows])
  const visibleRows = useMemo(
    () => rows.filter((row) => rowMatchesQuery(row, query, platform)),
    [rows, query, platform],
  )
  const groups = useMemo(() => groupRows(visibleRows), [visibleRows])
  const customizedCount = useMemo(() => rows.filter((row) => row.customized).length, [rows])

  const handleCapture = useCallback(
    (commandId: CommandId, chord: string) => {
      setCommandKeybindings(commandId, [chord])
      setCommandKeybindingDisabled(commandId, false)
      setRecordingId(null)
    },
    [setCommandKeybindings, setCommandKeybindingDisabled],
  )

  const handleResetAll = useCallback(async () => {
    const confirmed = await dialog.confirm({
      title: 'Reset all shortcuts?',
      body: 'Every custom shortcut and disabled command returns to its default. This cannot be undone.',
      confirmLabel: 'Reset all',
      tone: 'danger',
    })
    if (confirmed) resetAllKeybindings()
  }, [dialog, resetAllKeybindings])

  return (
    <div role="tabpanel" id="settings-panel-shortcuts" aria-labelledby="settings-tab-shortcuts" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <InboxSearchInput
          value={query}
          onChange={setQuery}
          ariaLabel="Search shortcuts by command, category, or key"
          placeholder="Search shortcuts"
        />
        <GhostButton
          onClick={handleResetAll}
          disabled={customizedCount === 0}
          aria-label="Reset all keyboard shortcuts to defaults"
          className="border border-[color:var(--border-default)] text-[color:var(--text-default)]"
        >
          Reset all{customizedCount > 0 ? ` (${customizedCount})` : ''}
        </GhostButton>
      </div>

      {groups.length === 0 ? (
        <p className="px-1 py-6 text-center text-[12px] text-[color:var(--text-muted)]">
          No commands match “{query.trim()}”.
        </p>
      ) : (
        <div className="-mx-3">
          {groups.map((group) => (
            <Section key={group.category} title={group.label} count={group.rows.length} inset={false}>
              <ul className="flex flex-col">
                {group.rows.map((row) => (
                  <ShortcutRowView
                    key={row.id}
                    row={row}
                    platform={platform}
                    conflicts={conflicts.get(row.id) ?? []}
                    recording={recordingId === row.id}
                    onStartRecording={() => setRecordingId(row.id)}
                    onCancelRecording={() => setRecordingId((current) => (current === row.id ? null : current))}
                    onCapture={(chord) => handleCapture(row.id, chord)}
                    onToggleDisabled={(next) => setCommandKeybindingDisabled(row.id, next)}
                    onReset={() => {
                      resetCommandKeybindings(row.id)
                      setRecordingId((current) => (current === row.id ? null : current))
                    }}
                  />
                ))}
              </ul>
            </Section>
          ))}
        </div>
      )}
    </div>
  )
}

function ShortcutRowView({
  row,
  platform,
  conflicts,
  recording,
  onStartRecording,
  onCancelRecording,
  onCapture,
  onToggleDisabled,
  onReset,
}: {
  row: ShortcutRow
  platform: KeybindingPlatform
  conflicts: readonly KeybindingConflict[]
  recording: boolean
  onStartRecording: () => void
  onCancelRecording: () => void
  onCapture: (chord: string) => void
  onToggleDisabled: (next: boolean) => void
  onReset: () => void
}) {
  const tone = conflictTone(conflicts)
  const message = conflictMessage(conflicts)
  const defaultDiffers =
    row.defaults.join(' ') !== row.effective.join(' ') && row.defaults.length > 0

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[color:var(--border-subtle)] py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[color:var(--text-strong)]">{row.title}</span>
          {tone && message ? (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={tone} label={message} />
              <span
                className={`text-[11px] ${tone === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--tone-warn)]'}`}
              >
                {message}
              </span>
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--text-muted)]">
          {row.disabled ? (
            <span className="text-[color:var(--text-subtle)]">Shortcut disabled</span>
          ) : row.effective.length > 0 ? (
            <ChordList chords={row.effective} platform={platform} />
          ) : (
            <span className="text-[color:var(--text-subtle)]">No shortcut</span>
          )}
          {defaultDiffers ? (
            <span className="inline-flex items-center gap-1.5 text-[color:var(--text-subtle)]">
              <span>Default</span>
              <ChordList chords={row.defaults} platform={platform} muted />
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <ShortcutRecorder
          row={row}
          platform={platform}
          recording={recording}
          onStartRecording={onStartRecording}
          onCancelRecording={onCancelRecording}
          onCapture={onCapture}
        />
        <Tooltip content={row.disabled ? 'Enable shortcut' : 'Disable shortcut'}>
          <Switch
            checked={!row.disabled}
            onChange={(next) => onToggleDisabled(!next)}
            ariaLabel={row.disabled ? `Enable the ${row.title} shortcut` : `Disable the ${row.title} shortcut`}
          />
        </Tooltip>
        {row.customized ? (
          <GhostButton onClick={onReset} aria-label={`Reset the ${row.title} shortcut to default`}>
            Reset
          </GhostButton>
        ) : (
          <span aria-hidden="true" className="inline-block h-7 w-[44px]" />
        )}
      </div>
    </li>
  )
}

function ChordList({
  chords,
  platform,
  muted,
}: {
  chords: readonly string[]
  platform: KeybindingPlatform
  muted?: boolean
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {chords.map((chord, index) => (
        <React.Fragment key={chord}>
          {index > 0 ? <span className="text-[color:var(--text-subtle)]">or</span> : null}
          <KbdChord chord={chord} platform={platform} className={muted ? 'opacity-70' : undefined} />
        </React.Fragment>
      ))}
    </span>
  )
}

function ShortcutRecorder({
  row,
  platform,
  recording,
  onStartRecording,
  onCancelRecording,
  onCapture,
}: {
  row: ShortcutRow
  platform: KeybindingPlatform
  recording: boolean
  onStartRecording: () => void
  onCancelRecording: () => void
  onCapture: (chord: string) => void
}) {
  const liveId = useRef(`shortcut-recorder-${row.id}`).current
  const hasBinding = row.effective.length > 0 && !row.disabled
  const restLabel = hasBinding ? 'Change' : 'Record'

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!recording) return
      // Tab must move focus, not be trapped — let it bubble and end recording.
      if (event.key === 'Tab') {
        onCancelRecording()
        return
      }
      // Swallow everything else so Settings does not close and app shortcuts do
      // not fire while capturing (the overlay closes on a bubbling Escape).
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        onCancelRecording()
        return
      }
      const chord = eventToChordString(event, platform)
      if (chord) onCapture(chord)
    },
    [recording, platform, onCancelRecording, onCapture],
  )

  return (
    <>
      <button
        type="button"
        aria-pressed={recording}
        aria-describedby={recording ? liveId : undefined}
        aria-label={
          recording
            ? `Recording a shortcut for ${row.title}. Press a key combination, or Escape to cancel.`
            : `${restLabel} the ${row.title} shortcut`
        }
        onClick={() => (recording ? onCancelRecording() : onStartRecording())}
        onKeyDown={handleKeyDown}
        onBlur={() => recording && onCancelRecording()}
        className={[
          'interactive inline-flex h-7 min-w-[68px] items-center justify-center rounded-[5px] px-2 text-[12px] font-medium',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]',
          recording
            ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
            : 'bg-transparent text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
        ].join(' ')}
      >
        {recording ? 'Press keys…' : restLabel}
      </button>
      <span id={liveId} role="status" aria-live="polite" className="sr-only">
        {recording ? `Recording a shortcut for ${row.title}. Press Escape to cancel.` : ''}
      </span>
    </>
  )
}
