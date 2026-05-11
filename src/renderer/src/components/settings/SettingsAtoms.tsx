import React from 'react'

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
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-[#ececee]">{label}</div>
        {description ? (
          <div className="mt-1 text-[12px] leading-5 text-[#5a5a63]">{description}</div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 disabled:opacity-45 ${
          enabled ? 'bg-[#5c7cff]' : 'bg-[#303139]'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform ${
            enabled ? 'translate-x-4 bg-[#08090b]' : 'translate-x-0 bg-[#d7d7dc]'
          }`}
        />
      </button>
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
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#5a5a63]">{label}</div>
      <div className={`mt-1 truncate font-medium ${metaToneClass(tone)}`}>{value}</div>
    </div>
  )
}

export function metaToneClass(tone?: MetaTone): string {
  switch (tone) {
    case 'positive':
      return 'text-[#b9f7c8]'
    case 'muted':
      return 'text-[#9a9aa2]'
    default:
      return 'text-[#ececee]'
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
