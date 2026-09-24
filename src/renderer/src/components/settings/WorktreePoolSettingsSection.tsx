// Settings → Agents → Worktree pool: whether agents lease their worktrees from
// a pool of warm ones, and how much of the disk and the idle time that pool
// may use. The settings live in main beside the pool (worktree-pool/), since
// the pool warms and evicts with no window open; this reads and writes them
// over IPC. Per-repository on/off and the slots themselves are in the Worktree
// manager.

import { useEffect, useState, type JSX } from 'react'

import {
  DEFAULT_WORKTREE_POOL_SETTINGS,
  WORKTREE_POOL_WARM_TARGET_MAX,
  type WorktreePoolSettings,
} from '../../../../shared/ipc/worktree-pool'
import { Input } from '../ui'
import { SettingCard, SettingsRow, SettingsSectionTitle, SettingToggle } from './SettingsAtoms'

type NumberKey = 'warmTarget' | 'diskCapGb' | 'idleEvictionDays'

const NUMBER_FIELDS: Array<{ key: NumberKey; label: string; help: string; min: number; max: number }> = [
  {
    key: 'warmTarget',
    label: 'Warm worktrees per repository',
    help: 'Kept ready at the default branch with dependencies installed, so a new agent starts at once.',
    min: 0,
    max: WORKTREE_POOL_WARM_TARGET_MAX,
  },
  {
    key: 'diskCapGb',
    label: 'Disk limit',
    help: 'GB, for every pool together. Over it, idle worktrees are removed, oldest first.',
    min: 1,
    max: 2000,
  },
  {
    key: 'idleEvictionDays',
    label: 'Remove idle worktrees after',
    help: 'Days a repository goes without a new agent before its idle worktrees are removed.',
    min: 1,
    max: 365,
  },
]

function NumberRow({
  field,
  value,
  disabled,
  onCommit,
}: {
  field: (typeof NUMBER_FIELDS)[number]
  value: number
  disabled: boolean
  onCommit: (value: number) => void
}): JSX.Element {
  const id = `worktree-pool-${field.key}`
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.max(field.min, Math.min(field.max, Math.round(parsed)))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <SettingsRow label={field.label} help={field.help} htmlFor={id} disabled={disabled}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={field.min}
        max={field.max}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </SettingsRow>
  )
}

export function WorktreePoolSettingsSection(): JSX.Element | null {
  const [settings, setSettings] = useState<WorktreePoolSettings | null>(null)
  const available = typeof window.api?.getWorktreePoolSettings === 'function'

  useEffect(() => {
    if (!available) return
    let cancelled = false
    void window.api
      .getWorktreePoolSettings()
      .catch(() => DEFAULT_WORKTREE_POOL_SETTINGS)
      .then((value) => {
        if (!cancelled) setSettings(value)
      })
    return () => {
      cancelled = true
    }
  }, [available])

  if (!available || !settings) return null

  const write = (patch: Partial<WorktreePoolSettings>): void => {
    setSettings({ ...settings, ...patch })
    void window.api
      .setWorktreePoolSettings(patch)
      .then(setSettings)
      .catch(() => {})
  }

  return (
    // No top rule on the section: the card draws its own edge.
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>Worktree pool</SettingsSectionTitle>
      <SettingCard>
        <SettingToggle
          label="Keep worktrees warm for new agents"
          description="An agent started on a worktree gets one that is already checked out and installed. Its branch is kept when it closes; uncommitted work holds the worktree until you decide in the Worktree manager."
          enabled={settings.enabled}
          onChange={(enabled) => write({ enabled })}
        />
        {NUMBER_FIELDS.map((field) => (
          <NumberRow
            key={field.key}
            field={field}
            value={settings[field.key]}
            disabled={!settings.enabled}
            onCommit={(value) => write({ [field.key]: value })}
          />
        ))}
      </SettingCard>
    </section>
  )
}
