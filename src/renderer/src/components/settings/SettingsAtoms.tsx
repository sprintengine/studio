import React from 'react'
import { Switch } from '../ui'

export type MetaTone = 'positive' | 'muted'

/**
 * The page header every Settings tab opens with (2026-09-06): the tab's name
 * as the one heading, and a trailing cluster for
 * the page's chrome — a count, a freshness note, glyph buttons. It is the
 * page saying its own name, so the rail can stay a rail; it carries no
 * sentence under it. What a setting does is said once, on its row.
 */
export function SettingsPageHeader({
  title,
  id,
  meta,
  actions,
}: {
  title: React.ReactNode
  id?: string
  /** A fact about the page — "12 bindings", "Checked 2 minutes ago". */
  meta?: React.ReactNode
  /** The page's chrome: glyph buttons and at most one text button. */
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex min-h-control-md items-center justify-between gap-3">
      <h3 id={id} className="min-w-0 truncate text-title font-semibold text-[color:var(--text-strong)]">
        {title}
      </h3>
      {meta || actions ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {meta ? <span className="mr-1 text-meta text-[color:var(--text-subtle)]">{meta}</span> : null}
          {actions}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Canonical settings section heading. One typographic treatment for every
 * section header across the Settings tabs: 14px semibold, sentence case,
 * flush-left, with an optional muted count next to the title and a trailing
 * action slot. Rendered as an h3: built-in tabs carry no page-level heading
 * (the rail orients), so a section title is the top heading in a tab body,
 * nesting directly under the Settings dialog's h2.
 *
 * Use this for in-tab section headers; do not hand-roll heading typography in a
 * settings tab — that is what drifted the sizes (12–14px) out of sync.
 */
export function SettingsSectionTitle({
  children,
  count,
  action,
  id,
  className,
}: {
  children: React.ReactNode
  count?: number
  action?: React.ReactNode
  id?: string
  className?: string
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${className ?? ''}`}>
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 id={id} className="text-title font-semibold text-[color:var(--text-strong)]">
          {children}
        </h3>
        {count !== undefined ? (
          <span className="tabular-nums text-body text-[color:var(--text-muted)]">{count}</span>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/**
 * Canonical settings row: label and one line of help on the left, a compact
 * right-aligned control on the right. Switches, inputs, selects, and action
 * sets all take this grammar. Compose consecutive rows inside a
 * `divide-y divide-[color:var(--border-subtle)]` wrapper for hairline rhythm.
 *
 * Controls passed as children stay sized to their content (240 px inputs,
 * intrinsic buttons) — never full-width.
 */
export function SettingsRow({
  label,
  help,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode
  help?: React.ReactNode
  /** When set, the label element targets this control id. */
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  const labelClass = 'block text-body font-medium text-[color:var(--text-strong)]'
  return (
    <div className={`flex items-center justify-between gap-8 py-3 first:pt-0 last:pb-0 ${className ?? ''}`}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
        ) : (
          <div className={labelClass}>{label}</div>
        )}
        {help ? (
          <div className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">{help}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/**
 * The switch row: the one shape for every boolean setting in the modal. Was
 * three copies (this, SettingsPanel's RegistrySwitchRow and CompoundSwitchRow)
 * until 2026-09-06; they drew the same row.
 */
export function SettingToggle({
  label,
  description,
  enabled,
  onChange,
  disabled,
  requirement,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  // A muted suffix on the label line naming an unmet prerequisite, e.g. "Needs
  // Sprint Engine". When present the row is typically also `disabled`.
  requirement?: string
}) {
  const labelId = React.useId()
  const helpId = description ? `${labelId}-help` : undefined
  return (
    <div className="flex items-center justify-between gap-8 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div id={labelId} className="text-body font-medium text-[color:var(--text-strong)]">
          {label}
          {requirement ? (
            <span className="ml-1.5 text-meta font-normal text-[color:var(--text-subtle)]">
              · {requirement}
            </span>
          ) : null}
        </div>
        {description ? (
          <div id={helpId} className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">
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
      <div className="text-meta text-[color:var(--text-muted)]">{label}</div>
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
