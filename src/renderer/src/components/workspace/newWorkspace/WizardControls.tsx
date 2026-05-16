// Leaf controls used by the new-workspace wizard. Extracted from
// NewWorkspacePanel.tsx so the wizard orchestrator stays focused on step
// state and navigation; these row primitives are pure presentation and have
// no closure ties to the wizard reducer.

import React from 'react'
import type { SprintEngineCliPermissionPreset } from '../../../types/workspace'
import { Select } from '../../ui'

export const cliPermissionOptions: Array<{
  value: SprintEngineCliPermissionPreset
  label: string
  hint: string
}> = [
  {
    value: 'default',
    label: 'Default permissions',
    hint: 'Use the CLI default permission behavior. Agents will prompt before sensitive actions.',
  },
  {
    value: 'auto_workspace',
    label: 'Auto in workspace',
    hint: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.',
  },
  {
    value: 'bypass_all',
    label: 'Bypass permissions',
    hint: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
]

export function CliPermissionPresetRow({
  preset,
  onChange,
}: {
  preset: SprintEngineCliPermissionPreset
  onChange: (preset: SprintEngineCliPermissionPreset) => void
}) {
  const current = cliPermissionOptions.find((option) => option.value === preset) ?? cliPermissionOptions[0]
  const isBypass = preset === 'bypass_all'
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Agent permissions</span>
          <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
            How spawned agents handle CLI permission prompts.
          </span>
        </span>
        <Select<SprintEngineCliPermissionPreset>
          ariaLabel="CLI permission preset"
          items={cliPermissionOptions.map((option) => ({ value: option.value, label: option.label }))}
          value={preset}
          onChange={onChange}
          className="shrink-0"
        />
      </div>
      <p
        className={`text-[11px] leading-4 ${
          isBypass ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-muted)]'
        }`}
      >
        {current.hint}
      </p>
    </div>
  )
}

export function PathRadio({
  checked,
  label,
  hint,
  disabled,
  onSelect,
}: {
  checked: boolean
  label: string
  hint: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={`
        grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-3 rounded-md border px-3.5 py-3 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        disabled:cursor-not-allowed disabled:opacity-55
        ${checked
          ? 'border-[color:var(--color-6)] bg-[color:var(--bg-surface-raised)]'
          : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
      `}
    >
      <span
        className={`mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full border ${
          checked ? 'border-[color:var(--text-strong)] bg-[color:var(--text-strong)]' : 'border-[color:var(--color-6)]'
        }`}
        aria-hidden="true"
      >
        {/* design-tokens-allow: inner glyph of a custom radio control — not a status dot */}
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--bg-app)]" /> : null}
      </span>
      <span className="min-w-0">
        <span className={`block text-[13px] font-semibold ${checked ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">{hint}</span>
      </span>
    </button>
  )
}
