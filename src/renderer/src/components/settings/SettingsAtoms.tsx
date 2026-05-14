import React from 'react'
import { Switch } from '../ui'

export type MetaTone = 'positive' | 'muted'

export function SettingToggle({
  label,
  description,
  enabled,
  onChange,
  disabled,
}: {
  label: string
  description?: string
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  const labelId = React.useId()
  const helpId = description ? `${labelId}-help` : undefined
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div id={labelId} className="text-sm font-semibold text-[color:var(--text-strong)]">
          {label}
        </div>
        {description ? (
          <div id={helpId} className="mt-1 text-[12px] leading-5 text-[color:var(--text-disabled)]">
            {description}
          </div>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        onChange={onChange}
        disabled={disabled}
        ariaLabelledBy={labelId}
        ariaDescribedBy={helpId}
        className="mt-0.5"
      />
    </div>
  )
}

export function MetaCell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: MetaTone
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[color:var(--text-muted)]">{label}</div>
      <div className={`mt-1 truncate font-medium ${metaToneClass(tone)}`}>{value}</div>
    </div>
  )
}

export function metaToneClass(tone?: MetaTone): string {
  switch (tone) {
    case 'positive':
      return 'text-[color:var(--tone-good)]'
    case 'muted':
      return 'text-[color:var(--text-muted)]'
    default:
      return 'text-[color:var(--text-strong)]'
  }
}

export function formatNullableDate(value: string | null | undefined): string {
  return value ? formatDate(value) : 'None'
}

export function formatDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
