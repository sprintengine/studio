import React from 'react'

import type { TailnetScope } from '../../../../shared/tailnet'
import { DescribedCheckRow, DescribedCheckRowList, SegmentedControl } from '../ui'
import { SCOPE_ROWS, presetFor, scopesForPreset, toggleScope, type ScopePreset } from './scopePickerModel'

// The permission body, once (remote-settings-rebuild): a preset strip and the
// six described rows, in `TAILNET_SCOPES` order.
//
// It is ONE component because two surfaces put the same question and used to
// answer it differently — the Pair a device modal ("what may this machine do
// here?") and the inbound pair-request card ("what may the machine asking do
// here?"). The card offered four bundled family rows with the terminal tier
// unticked; the modal offered no choice at all and minted the structured set.
// Whichever set of words a person met decided whether cross-machine chats
// worked, which is not a decision copy should be making.
//
// Controlled, and deliberately state-free: the chosen set belongs to whoever
// will send it (`tailnetOfferPairing`, `fleetRequestPairing`, the approval), so
// there is no moment where the rows and the button disagree about what is
// about to be granted.

/**
 * The value the strip carries when the chosen set is NEITHER preset.
 *
 * A radiogroup always has a value, and no value in `items` means no segment is
 * marked — which is exactly the state the design asks for: touching a row drops
 * the preset highlight, and it re-lights when the set matches again. A sentinel
 * rather than a third "Custom" segment, because "custom" is not something a
 * person can CHOOSE — it is what is true after they chose something else.
 */
const NO_PRESET = 'custom'

type PresetValue = ScopePreset | typeof NO_PRESET

export function ScopePicker({
  value,
  onChange,
  disabled = false,
  /** Names the row inputs and the list, so two pickers on one page never share an id. */
  idPrefix,
  className,
}: {
  value: TailnetScope[]
  onChange: (next: TailnetScope[]) => void
  disabled?: boolean
  idPrefix?: string
  className?: string
}) {
  const generatedId = React.useId()
  const prefix = idPrefix ?? generatedId
  // Derived, never stored: a preset is a NAME for a set, so the strip lights
  // when the set matches and goes dark the moment a row is touched, with no
  // second copy of the truth to fall out of step.
  const preset = presetFor(value)
  const items = React.useMemo(
    () => [
      { value: 'read-only' as PresetValue, label: 'Read only', disabled },
      { value: 'standard' as PresetValue, label: 'Standard', disabled },
    ],
    [disabled],
  )

  return (
    <div className={['flex flex-col gap-2', className ?? ''].join(' ')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body font-medium text-[color:var(--text-default)]">Permissions</span>
        <SegmentedControl<PresetValue>
          ariaLabel="Permission preset"
          size="sm"
          items={items}
          // `NO_PRESET` matches no segment, so a hand-picked set leaves both
          // unmarked rather than claiming one of them.
          value={preset ?? NO_PRESET}
          onChange={(next) => {
            if (next !== NO_PRESET) onChange(scopesForPreset(next))
          }}
        />
      </div>
      <DescribedCheckRowList ariaLabel="Permissions">
        {SCOPE_ROWS.map((row) => (
          <DescribedCheckRow
            key={row.scope}
            id={`${prefix}-${row.scope.replace(':', '-')}`}
            title={row.title}
            code={row.code}
            description={row.description}
            checked={value.includes(row.scope)}
            disabled={disabled}
            onChange={(next) => onChange(toggleScope(value, row.scope, next))}
          />
        ))}
      </DescribedCheckRowList>
    </div>
  )
}
