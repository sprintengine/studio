import React from 'react'

import type { TailnetPairRequest } from '../../../../shared/tailnet'
import { GhostButton, Input, PrimaryButton } from '../ui'
import { shortMachineName } from './machineRowModel'
import { DEFAULT_PAIR_SCOPES, usePairRequestAnswer } from './pairRequestAnswer'

// Answering a pair request from the toast it arrives in (owner ruling
// 2026-09-05, recorded in design-system/components/toast/component.md): the
// code field and the two answers, nothing else. The old toast only pointed
// at the Remote glyph — a person at the machine, watching the asking screen,
// had to go somewhere else to type the digits it was showing.
//
// Allow here grants `DEFAULT_PAIR_SCOPES` — everything but terminal control,
// which is never granted by a surface that did not show the words. The card
// in the Remote popover remains the surface that chooses scopes, and the
// helper line says so in one line rather than pointing at it.
export function PairRequestToastAccept({ request }: { request: TailnetPairRequest }) {
  const { code, setCode, codeError, busy, answer } = usePairRequestAnswer(request.id)
  const inputId = React.useId()
  const helpId = `${inputId}-help`
  // The same short name the toast's title carries: the field is labelled by
  // the machine a person is looking at, not by its tailnet FQDN.
  const asker = shortMachineName(request.peerNode ?? request.peerAddress)
  const disabled = busy !== null

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && code.length === 6 && !disabled) void answer('allow', DEFAULT_PAIR_SCOPES)
          }}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          aria-label={`Code shown on ${asker}`}
          aria-describedby={helpId}
          aria-invalid={codeError ? true : undefined}
          disabled={disabled}
          fullWidth={false}
          className="w-[92px] text-center font-mono tracking-[0.2em]"
        />
        <span className="flex-1" />
        <GhostButton size="sm" disabled={disabled} onClick={() => void answer('decline', DEFAULT_PAIR_SCOPES)}>
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </GhostButton>
        <PrimaryButton
          size="sm"
          disabled={disabled || code.length !== 6}
          onClick={() => void answer('allow', DEFAULT_PAIR_SCOPES)}
        >
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </PrimaryButton>
      </div>
      <p
        id={helpId}
        className={`mt-1 text-micro ${codeError ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'}`}
      >
        {codeError ?? 'Type the code it is showing. Terminal control stays off.'}
      </p>
    </div>
  )
}
