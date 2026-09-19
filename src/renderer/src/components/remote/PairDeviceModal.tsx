import React from 'react'

import { TAILNET_SCOPES, type TailnetScope } from '../../../../shared/tailnet'
import { GhostButton, PrimaryButton } from '../ui'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal'
import { ScopePicker } from './ScopePicker'
import { STANDARD_SCOPES } from './scopePickerModel'

// "Pair a device" (remote-settings-rebuild §6): choose what the other machine
// may do here, then create the link.
//
// The dialog exists because the choice did not. Every pairing path — the button
// on this tab, the peer row's Connect, the toast's Allow — granted
// `TAILNET_STRUCTURED_SCOPES` and offered nothing to tick, which is why no
// paired machine could see another's chats: the terminal tier was never on the
// table. Now the eight rows ARE the dialog, and the only other control is the
// preset that fills them in.
//
// One dialog for both directions. Pairing is always both ways (owner ruling
// 2026-09-10), so the set chosen here is sent as the request's scopes AND as
// its `reverseScopes`; there is no checkbox for "also let that machine drive
// this device", because there is no longer a case where the answer is no.

export type PairDeviceTarget =
  /** No target: mint a code here and let the other machine come to it. */
  | { kind: 'code' }
  /**
   * A machine picked off the Machines list: ask IT to pair, which is the path
   * that needs someone at the far end to press Allow.
   */
  | { kind: 'peer'; endpoint: string; machineName: string }

export function PairDeviceModal({
  open,
  target,
  onClose,
  onCreate,
  busy = false,
}: {
  open: boolean
  target: PairDeviceTarget
  onClose: () => void
  /** Mint the code, or send the request. The tab owns the IPC and the errors. */
  onCreate: (scopes: TailnetScope[], target: PairDeviceTarget) => void
  busy?: boolean
}) {
  const titleId = React.useId()
  const [scopes, setScopes] = React.useState<TailnetScope[]>(() => [...STANDARD_SCOPES])

  // Every opening starts from the preset again. A dialog that remembered the
  // last set would silently grant a machine what the PREVIOUS machine got,
  // which is the one thing a permission dialog must not do.
  React.useEffect(() => {
    if (open) setScopes([...STANDARD_SCOPES])
  }, [open, target])

  const create = (): void => {
    if (scopes.length === 0) return
    onCreate(
      // Vocabulary order on the way out, whatever order the rows were ticked
      // in, so the pills on the code card and the stored device read the same.
      TAILNET_SCOPES.filter((scope) => scopes.includes(scope)),
      target,
    )
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} size="standard">
      {/* No subtitle: the eight rows say what the dialog is for, and a
          sentence above them would only be a worse version of them. */}
      <ModalHeader title="Pair a device" titleId={titleId} onClose={onClose} />
      <ModalBody>
        <ScopePicker value={scopes} onChange={setScopes} disabled={busy} idPrefix="pair-device" />
      </ModalBody>
      <ModalFooter>
        <GhostButton size="md" onClick={onClose} disabled={busy}>
          Cancel
        </GhostButton>
        <PrimaryButton size="md" onClick={create} disabled={busy || scopes.length === 0}>
          {target.kind === 'peer' ? 'Ask to pair' : 'Create link'}
        </PrimaryButton>
      </ModalFooter>
    </Modal>
  )
}
