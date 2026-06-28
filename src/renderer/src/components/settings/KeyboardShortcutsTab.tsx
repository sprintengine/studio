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
  collapseDuplicateKeybindings,
  findKeybindingConflicts,
  keyFromEvent,
  normalizeKeybinding,
  renderKeybinding,
  type CommandCategory,
  type CommandContribution,
  type CommandScope,
  type KeybindingConflict,
  type KeybindingConflictCandidate,
  type KeybindingPlatform,
} from '../../commands'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import type { KeybindingSettings } from '../../types/workspace'
import { SettingsSectionTitle } from './SettingsAtoms'
import {
  FOCUS_RING_CLASS,
  GhostButton,
  IconButton,
  InboxSearchInput,
  KbdChord,
  StatusDot,
  Tooltip,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'

// --- View model (pure, exported for tests) ---------------------------------

export type ShortcutRow = {
  id: string
  title: string
  /** A built-in CommandCategory or a module command's own grouping label. */
  category: string
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
  sprintengine: 'Sprint',
  multiloop: 'Multiloop',
  watchtower: 'Watchtower',
  switchboard: 'Switchboard',
  git: 'Git',
  terminal: 'Terminal',
  diagnostics: 'Diagnostics',
}

// Module command categories are already display labels, so they pass through.
export function categoryLabel(category: string): string {
  return (CATEGORY_LABELS as Partial<Record<string, string>>)[category] ?? category
}

export function buildShortcutRows(
  commands: readonly CommandContribution[],
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
      id: def.id,
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

export type ShortcutGroup = { category: string; label: string; rows: ShortcutRow[] }

/** Group rows by category, preserving the order categories first appear in. */
export function groupRows(rows: readonly ShortcutRow[]): ShortcutGroup[] {
  const groups: ShortcutGroup[] = []
  const index = new Map<string, ShortcutGroup>()
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
  const [recordingId, setRecordingId] = useState<string | null>(null)

  const keybindings = useMemo<KeybindingSettings>(() => ({ overrides, disabled }), [overrides, disabled])
  // Shell commands plus the commands of currently enabled modules. Disabling a
  // module drops its rows here reactively; its persisted overrides stay in
  // settings, so re-enabling restores the rows with the customization intact.
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  const commands = useMemo(
    () => getRendererHost().getCommandContributions((moduleId) => selectModuleEnabled(moduleEnablement, moduleId)),
    [moduleEnablement],
  )
  const rows = useMemo(() => buildShortcutRows(commands, keybindings), [commands, keybindings])
  const conflicts = useMemo(() => computeConflicts(rows), [rows])
  const visibleRows = useMemo(
    () => rows.filter((row) => rowMatchesQuery(row, query, platform)),
    [rows, query, platform],
  )
  const groups = useMemo(() => groupRows(visibleRows), [visibleRows])
  const customizedCount = useMemo(() => rows.filter((row) => row.customized).length, [rows])

  const handleCapture = useCallback(
    (commandId: string, chord: string) => {
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
        <div className="flex flex-col">
          {groups.map((group, index) => (
            <section
              key={group.category}
              className={index > 0 ? 'mt-4 border-t border-[color:var(--border-subtle)] pt-4' : ''}
            >
              <SettingsSectionTitle count={group.rows.length} className="mb-1.5">
                {group.label}
              </SettingsSectionTitle>
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
                    onRemove={() => {
                      setCommandKeybindingDisabled(row.id, true)
                      setRecordingId((current) => (current === row.id ? null : current))
                    }}
                    onReset={() => {
                      resetCommandKeybindings(row.id)
                      setRecordingId((current) => (current === row.id ? null : current))
                    }}
                  />
                ))}
              </ul>
            </section>
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
  onRemove,
  onReset,
}: {
  row: ShortcutRow
  platform: KeybindingPlatform
  conflicts: readonly KeybindingConflict[]
  recording: boolean
  onStartRecording: () => void
  onCancelRecording: () => void
  onCapture: (chord: string) => void
  onRemove: () => void
  onReset: () => void
}) {
  const tone = conflictTone(conflicts)
  const message = conflictMessage(conflicts)
  const hasBinding = row.effective.length > 0
  const defaultRendered = row.defaults.map((chord) => renderKeybinding(chord, platform)).join(' or ')

  return (
    <li className="group flex items-center gap-3 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px] text-[color:var(--text-strong)]">{row.title}</span>
        {tone && message ? (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <StatusDot tone={tone} label={message} />
            <span
              className={`whitespace-nowrap text-[11px] ${tone === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--tone-warn)]'}`}
            >
              {message}
            </span>
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <KeybindingCell
          row={row}
          platform={platform}
          recording={recording}
          onStartRecording={onStartRecording}
          onCancelRecording={onCancelRecording}
          onCapture={onCapture}
        />
        <span className="flex w-[52px] items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {row.customized ? (
            <Tooltip content={defaultRendered ? `Reset to ${defaultRendered}` : 'Reset to default'}>
              <IconButton onClick={onReset} aria-label={`Reset the ${row.title} shortcut to default`}>
                <ResetIcon />
              </IconButton>
            </Tooltip>
          ) : null}
          {hasBinding ? (
            <Tooltip content="Remove shortcut">
              <IconButton onClick={onRemove} aria-label={`Remove the ${row.title} shortcut`}>
                <RemoveIcon />
              </IconButton>
            </Tooltip>
          ) : null}
        </span>
      </div>
    </li>
  )
}

function ChordList({ chords, platform }: { chords: readonly string[]; platform: KeybindingPlatform }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      {chords.map((chord, index) => (
        <React.Fragment key={chord}>
          {index > 0 ? <span className="text-[11px] text-[color:var(--text-subtle)]">or</span> : null}
          <KbdChord chord={chord} platform={platform} />
        </React.Fragment>
      ))}
    </span>
  )
}

// The keybinding cell is the edit affordance: click to record, Escape to cancel.
// At rest it shows the effective chord(s), or a muted "Add shortcut" prompt when
// the command has none (default removed or never bound).
function KeybindingCell({
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
  const hasBinding = row.effective.length > 0

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
            : hasBinding
              ? `Change the ${row.title} shortcut`
              : `Add a shortcut for ${row.title}`
        }
        onClick={() => (recording ? onCancelRecording() : onStartRecording())}
        onKeyDown={handleKeyDown}
        onBlur={() => recording && onCancelRecording()}
        className={[
          'interactive inline-flex h-7 min-w-[72px] items-center justify-end gap-1.5 rounded-[5px] px-2',
          FOCUS_RING_CLASS,
          recording
            ? 'bg-[color:var(--accent-primary-soft)]'
            : 'bg-transparent hover:bg-[color:var(--bg-hover)]',
        ].join(' ')}
      >
        {recording ? (
          <span className="text-[12px] font-medium text-[color:var(--accent-primary)]">Press keys…</span>
        ) : hasBinding ? (
          <ChordList chords={row.effective} platform={platform} />
        ) : (
          <span className="text-[12px] text-[color:var(--text-subtle)] group-hover:text-[color:var(--text-muted)]">
            Add shortcut
          </span>
        )}
      </button>
      <span id={liveId} role="status" aria-live="polite" className="sr-only">
        {recording ? `Recording a shortcut for ${row.title}. Press Escape to cancel.` : ''}
      </span>
    </>
  )
}

function ResetIcon() {
  return (
    <svg
      className="icon-sm"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

function RemoveIcon() {
  return (
    <svg
      className="icon-sm"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  )
}
