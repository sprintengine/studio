import React from 'react'

import {
  MACHINE_COLOUR_LABELS,
  MACHINE_COLOURS,
  MACHINE_KIND_LABELS,
  MACHINE_KINDS,
  defaultMachineColour,
  defaultMachineKind,
  machineIdOf,
  type MachineColour,
  type MachineIdentity,
  type MachineKind,
  type MachineRef,
} from '../../../../shared/machine-identity'
import { useMachineIdentity } from '../../hooks/useMachineIdentity'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  GhostButton,
  IconButton,
  LinkButton,
  MACHINE_COLOUR_FILL,
  MachineGlyph,
  MachineKindGlyph,
  Popover,
} from '../ui'

// Settings › Machines: a machine's kind and colour (owner ruling 2026-10-04).
// Every machine row but this computer's carries its mark in the leading slot
// and a Change control that opens the two pickers — the nine kinds drawn as
// themselves, and the eight colours as swatches — with a way back to the
// defaults once either was changed. A pick writes at once; the mark on the row,
// and every other mark of that machine in the window, follows.

/** The words under a machine's name: what it is, and whether that was picked for you. */
export function machineMarkWords(identity: MachineIdentity): string {
  return `${MACHINE_KIND_LABELS[identity.kind]}, ${MACHINE_COLOUR_LABELS[identity.colour].toLowerCase()}, ${
    identity.overridden ? 'set by you' : 'picked for you'
  }`
}

/** A machine's mark for a settings row's leading slot: its glyph, in its colour, at the slot's size. */
export function MachineRowMark({ machine }: { machine: MachineRef }): React.JSX.Element | null {
  const identity = useMachineIdentity(machine)
  return identity ? <MachineGlyph identity={identity} className="size-icon-lg" /> : null
}

export function MachineMarkPicker({ machine, name }: { machine: MachineRef; name: string }): React.JSX.Element | null {
  const identity = useMachineIdentity(machine)
  const setMachineMark = useWorkspaceStore((s) => s.setMachineMark)
  const [open, setOpen] = React.useState(false)
  const id = machineIdOf(machine)
  const defaultKind = defaultMachineKind(machine)
  if (!identity || !id || !defaultKind) return null
  // A pick that lands back on a default is stored as no override at all, so a
  // later change to the defaults reaches this machine again.
  const write = (kind: MachineKind, colour: MachineColour): void => {
    const mark = {
      ...(kind !== defaultKind ? { kind } : {}),
      ...(colour !== defaultMachineColour(id) ? { colour } : {}),
    }
    setMachineMark(id, mark.kind || mark.colour ? mark : null)
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Kind and colour for ${name}`}
      popupRole="dialog"
      placement="bottom-end"
      surfaceClassName="w-[300px] p-3"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <GhostButton
          ref={ref}
          size="xs"
          onClick={togglePopover}
          aria-label={`Change the mark for ${name}`}
          {...triggerProps}
        >
          Change
        </GhostButton>
      )}
    >
      <div className="flex flex-col gap-3">
        <PickerGroup label="Kind" ariaLabel={`Kind for ${name}`}>
          {MACHINE_KINDS.map((kind) => (
            <IconButton
              key={kind}
              size="md"
              role="radio"
              aria-checked={identity.kind === kind}
              aria-pressed={undefined}
              pressed={identity.kind === kind}
              aria-label={MACHINE_KIND_LABELS[kind]}
              tabIndex={identity.kind === kind ? 0 : -1}
              data-machine-kind-choice={kind}
              onClick={() => write(kind, identity.colour)}
            >
              <MachineKindGlyph kind={kind} className="icon-sm" />
            </IconButton>
          ))}
        </PickerGroup>
        <PickerGroup label="Colour" ariaLabel={`Colour for ${name}`}>
          {MACHINE_COLOURS.map((colour) => (
            <IconButton
              key={colour}
              size="md"
              role="radio"
              aria-checked={identity.colour === colour}
              aria-pressed={undefined}
              pressed={identity.colour === colour}
              aria-label={MACHINE_COLOUR_LABELS[colour]}
              tabIndex={identity.colour === colour ? 0 : -1}
              data-machine-colour-choice={colour}
              onClick={() => write(identity.kind, colour)}
            >
              {/* A swatch, square on the chip radius: a colour sample, never
                  a disc (the app draws no status dots). */}
              <span aria-hidden="true" className={`size-icon-sm rounded-xs ${MACHINE_COLOUR_FILL[colour]}`} />
            </IconButton>
          ))}
        </PickerGroup>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <MachineGlyph identity={identity} />
            {machineMarkWords(identity)}
          </span>
          {identity.overridden ? (
            <LinkButton onClick={() => setMachineMark(id, null)}>Use the defaults</LinkButton>
          ) : null}
        </div>
      </div>
    </Popover>
  )
}

/**
 * A labelled radio group whose arrow keys move the choice, the way a radio
 * group answers them: the focus and the pick move together, and the group is
 * one tab stop (the checked choice).
 */
function PickerGroup({
  label,
  ariaLabel,
  children,
}: {
  label: string
  ariaLabel: string
  children: React.ReactNode
}): React.JSX.Element {
  const labelId = React.useId()
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const at = radios.findIndex((radio) => radio === document.activeElement)
    if (at < 0) return
    event.preventDefault()
    const next = radios[(at + step + radios.length) % radios.length]!
    next.focus()
    next.click()
  }
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-meta font-medium text-[color:var(--text-muted)]">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        aria-describedby={labelId}
        className="flex flex-wrap gap-0.5"
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  )
}
