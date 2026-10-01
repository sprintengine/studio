import React from 'react'

import { TAILNET_SCOPES, type TailnetScope } from '../../../../shared/tailnet'
import { Field, GhostButton, PrimaryButton, Select, type SelectItem } from '../ui'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal'
import { ScopePicker } from './ScopePicker'
import { STANDARD_SCOPES } from './scopePickerModel'

// "Pair a device" (remote-settings-rebuild §6): choose which machine, choose
// what it may do here, then ask it or create the link.
//
// The dialog exists because the choice did not. Every pairing path — the button
// on this tab, the peer row's Connect, the toast's Allow — granted one house
// set and offered nothing to tick, which is why no paired machine could see
// another's chats: the scopes that show them were never on the table. Now the
// six rows ARE the dialog, and the only other control is the preset that fills
// them in.
//
// One dialog for both directions. Pairing is always both ways (owner ruling
// 2026-09-10), so the set chosen here is sent as the request's scopes AND as
// its `reverseScopes`; there is no checkbox for "also let that machine drive
// this device", because there is no longer a case where the answer is no.
//
// Which machine is chosen here too, from the scan. The header's "Pair a device"
// used to go straight to a link, so pairing two machines sitting side by side
// meant carrying a URL from one to the other — while the route that needs no
// carrying, asking the other Studio and typing six digits, sat on a row button
// further down. The machines a Studio answers on are now the first choices, and
// the link is the last one: for a phone, or a machine nobody is sitting at.

export type PairDeviceTarget =
  /** No target: mint a code here and let the other machine come to it. */
  | { kind: 'code' }
  /**
   * A machine picked off the Machines list: ask IT to pair, which is the path
   * that needs someone at the far end to press Allow.
   */
  | { kind: 'peer'; endpoint: string; machineName: string }

type PeerTarget = Extract<PairDeviceTarget, { kind: 'peer' }>

/** The Select's value for the link choice; a peer's is its endpoint. */
const LINK_CHOICE = 'link'

export function PairDeviceModal({
  open,
  target,
  peers,
  onClose,
  onCreate,
  busy = false,
}: {
  open: boolean
  /** The choice the dialog opens on. */
  target: PairDeviceTarget
  /** Machines a Studio answered on and that are not yet paired: the other choices. */
  peers: readonly PeerTarget[]
  onClose: () => void
  /** Mint the code, or send the request. The tab owns the IPC and the errors. */
  onCreate: (scopes: TailnetScope[], target: PairDeviceTarget) => void
  busy?: boolean
}) {
  const titleId = React.useId()
  const choiceId = React.useId()
  const [scopes, setScopes] = React.useState<TailnetScope[]>(() => [...STANDARD_SCOPES])
  const [choice, setChoice] = React.useState<string>(() => choiceOf(target))

  // Every opening starts from the preset again. A dialog that remembered the
  // last set would silently grant a machine what the PREVIOUS machine got,
  // which is the one thing a permission dialog must not do.
  React.useEffect(() => {
    if (!open) return
    setScopes([...STANDARD_SCOPES])
    setChoice(choiceOf(target))
  }, [open, target])

  // The opening target is always offered, even when a rescan has since dropped
  // it from `peers`: a row's Pair should never open on a different machine.
  const choices = React.useMemo(() => {
    const listed = target.kind === 'peer' && !peers.some((peer) => peer.endpoint === target.endpoint)
    return listed ? [target, ...peers] : [...peers]
  }, [target, peers])
  const chosen: PairDeviceTarget = choices.find((peer) => peer.endpoint === choice) ?? { kind: 'code' }

  const items: SelectItem[] = [
    ...choices.map((peer) => ({ value: peer.endpoint, label: peer.machineName })),
    { value: LINK_CHOICE, label: 'A phone or another device — make a link' },
  ]

  const create = (): void => {
    if (scopes.length === 0) return
    onCreate(
      // Vocabulary order on the way out, whatever order the rows were ticked
      // in, so the pills on the code card and the stored device read the same.
      TAILNET_SCOPES.filter((scope) => scopes.includes(scope)),
      chosen,
    )
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} size="standard">
      {/* No subtitle: the eight rows say what the dialog is for, and a
          sentence above them would only be a worse version of them. */}
      <ModalHeader title="Pair a device" titleId={titleId} onClose={onClose} />
      <ModalBody>
        <div className="flex flex-col gap-4">
          {/* Only when there is a choice to make: with no Studio answering on
              the tailnet, a one-item select would be a control that does
              nothing, and the button below already says "Create link". */}
          {choices.length > 0 ? (
            <Field label="Pair with" htmlFor={choiceId}>
              <Select
                ariaLabel="Pair with"
                items={items}
                value={chosen.kind === 'peer' ? chosen.endpoint : LINK_CHOICE}
                onChange={setChoice}
                disabled={busy}
              />
            </Field>
          ) : null}
          <ScopePicker value={scopes} onChange={setScopes} disabled={busy} idPrefix="pair-device" />
        </div>
      </ModalBody>
      <ModalFooter>
        <GhostButton size="md" onClick={onClose} disabled={busy}>
          Cancel
        </GhostButton>
        <PrimaryButton size="md" onClick={create} disabled={busy || scopes.length === 0}>
          {chosen.kind === 'peer' ? 'Ask to pair' : 'Create link'}
        </PrimaryButton>
      </ModalFooter>
    </Modal>
  )
}

function choiceOf(target: PairDeviceTarget): string {
  return target.kind === 'peer' ? target.endpoint : LINK_CHOICE
}
