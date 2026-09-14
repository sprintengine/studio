import React from 'react'

/**
 * The setting row and the card it lives in — the shipped counterpart of
 * `design-system/components/setting-row`.
 *
 * The card ships with the row rather than being left to the caller for the
 * same reason `DescribedCheckRowList` does: the divider's inset and the row's
 * padding are one decision, and a host drawing its own `divide-y` puts the
 * rule at its own inset. Thirteen hand-rolled wrappers is exactly how the
 * settings tabs ended up with three different insets and two different divider
 * colours.
 *
 * Card, not bare rows, by ruling 2026-09-14 (`foundations/principles.md`,
 * *Hairlines carry the structure*): a settings page is a long scroll of rows
 * with nothing in common, and past eight rows the gap between two groups reads
 * the same as the gap between two rows.
 */

/**
 * The card a run of setting rows sits in: `border.subtle`, `radius.shell`,
 * `bg.surface-raised`, hairlines between rows and never around them.
 *
 * A plain `<div>` with no role by default: a card of unrelated settings is not
 * a list and must not claim to be one. Pass `as="ul"` when the rows genuinely
 * *are* a list of like things (paired devices, tailnet machines, recent
 * messages) — then the rows are `<li>`s and `ariaLabel` names the list.
 */
export function SettingCard({
  as = 'div',
  ariaLabel,
  className,
  children,
}: {
  as?: 'div' | 'ul'
  /** Names the list. Only meaningful with `as="ul"`. */
  ariaLabel?: string
  className?: string
  children: React.ReactNode
}): JSX.Element {
  const Host = as
  return (
    <Host
      aria-label={as === 'ul' ? ariaLabel : undefined}
      className={[
        as === 'ul' ? 'list-none p-0' : '',
        // `overflow-hidden`: the rows are square-cornered and full-bleed, and
        // the card's radius is what clips the first and last of them. A
        // rounded row inset in a padded card is a card in a card.
        'overflow-hidden rounded-lg border border-[color:var(--border-subtle)]',
        'bg-[color:var(--bg-surface-raised)]',
        // The divider goes BETWEEN rows and never around them, so the card's
        // own border is never doubled and a one-row card carries no rule.
        '[&>*+*]:border-t [&>*+*]:border-[color:var(--border-subtle)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </Host>
  )
}

export type SettingRowProps = {
  label: React.ReactNode
  /** One or two lines saying what the setting does — not what the control is. */
  help?: React.ReactNode
  /** When set, the label targets this control id and becomes a real `<label>`. */
  htmlFor?: string
  /**
   * A muted suffix on the label line naming an unmet prerequisite, e.g.
   * "Needs Sprint Engine". It sits inside the labelled element, so a screen
   * reader reads it as part of the control's name rather than losing it.
   */
  requirement?: string
  /** Dims the control host and drops the text to `text.muted`. */
  disabled?: boolean
  /** The control drops under the text, for one that needs the full width. */
  stacked?: boolean
  /** Ids for callers whose control cannot take a `for` target. */
  labelId?: string
  helpId?: string
  className?: string
  children: React.ReactNode
}

/**
 * One setting: label and at most two lines of help on the left, the control
 * that changes it on the right. Render it inside a `SettingCard`.
 *
 * The row is a `<div>` and takes no focus — it is a label for a control, not a
 * control. It has no hover fill and no selected state, which is what separates
 * it from `InboxRow`: nothing here is picked.
 */
export function SettingRow({
  label,
  help,
  htmlFor,
  requirement,
  disabled,
  stacked,
  labelId,
  helpId,
  className,
  children,
}: SettingRowProps): JSX.Element {
  const labelClass = [
    'block text-body font-medium',
    disabled ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-strong)]',
  ].join(' ')
  const labelBody = (
    <>
      {label}
      {requirement ? (
        <span className="ml-1.5 text-meta font-normal text-[color:var(--text-subtle)]">
          · {requirement}
        </span>
      ) : null}
    </>
  )
  return (
    <div
      className={[
        'flex min-h-control-lg gap-5 px-3 py-2.5',
        stacked ? 'flex-col items-stretch gap-2.5' : 'items-center justify-between',
        className ?? '',
      ].join(' ')}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label id={labelId} htmlFor={htmlFor} className={labelClass}>
            {labelBody}
          </label>
        ) : (
          <div id={labelId} className={labelClass}>
            {labelBody}
          </div>
        )}
        {help ? (
          <div id={helpId} className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">
            {help}
          </div>
        ) : null}
      </div>
      {/* The host never dims: every kit control brings its own disabled tone
          (Switch draws `disabled:opacity-45`), and a second opacity on the
          wrapper multiplies with it down to about a fifth. */}
      <div className={['flex items-center gap-2', stacked ? '' : 'shrink-0'].join(' ')}>
        {children}
      </div>
    </div>
  )
}
