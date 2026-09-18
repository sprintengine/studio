import React from 'react'

import type { TailnetScope } from '../../../../shared/tailnet'
import { showToast } from '../../store/toastStore'

// Answering a pair request, in one place: the code normaliser and the IPC
// round trip with its inline-mismatch rule. Two surfaces answer — the full card
// (the Remote popover and Settings → Remote) and the toast the request arrives
// as (owner ruling 2026-09-05) — and neither may drift from the other on what a
// wrong code does.

// The scope VOCABULARY moved to `scopePickerModel.ts` and the rows to
// `ScopePicker.tsx` (remote-settings-rebuild). What used to live here was four
// combined family rows with the terminal tier unticked, plus a
// `DEFAULT_PAIR_SCOPES` constant for the surfaces that showed no rows at all —
// the toast's Allow and the peer picker's reverse grant. Both are gone:
//
//   * there is no house default any more. An inbound request carries
//     `requestedScopes`, and every surface that answers one grants exactly
//     that, so the toast and the card can no longer disagree about what Allow
//     means.
//   * an OUTBOUND pairing is chosen in the Pair a device dialog, where all
//     eight rows are on screen with the words "Arbitrary shell on this
//     machine" against the last of them (owner ruling 2026-09-10).
//
// What remains here is the part both surfaces genuinely share: the typed code
// and the IPC round trip, with its inline-mismatch rule.

/** Digits only, at most six: "481 972" read off a screen is the same answer as "481972". */
function normalizeTypedCode(value: string): string {
  return value.replace(/\D/gu, '').slice(0, 6)
}

export type PairRequestAnswer = {
  code: string
  setCode: (value: string) => void
  /** Main's words for a code that did not match, shown beside the field — never as a toast. */
  codeError: string | null
  busy: 'allow' | 'decline' | null
  answer: (kind: 'allow' | 'decline', scopes: TailnetScope[]) => Promise<void>
}

/**
 * The typed code and the two answers, for whichever surface is drawing the
 * request. Main compares the code; a wrong one is refused inline and the
 * field clears for another try; the third wrong code declines the request.
 * Resolution reaches every surface over the push channel, so no double-answer
 * is possible and success is silent here.
 */
export function usePairRequestAnswer(requestId: string): PairRequestAnswer {
  const [code, setCodeState] = React.useState('')
  const [codeError, setCodeError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'allow' | 'decline' | null>(null)

  const setCode = React.useCallback((value: string) => {
    setCodeState(normalizeTypedCode(value))
    setCodeError((current) => (current === null ? current : null))
  }, [])

  const answer = React.useCallback(
    async (kind: 'allow' | 'decline', scopes: TailnetScope[]): Promise<void> => {
      if (busy) return
      setBusy(kind)
      try {
        if (kind === 'allow') {
          const result = await window.api.tailnetApprovePairRequest(requestId, scopes, code)
          if (!result.ok) {
            if (result.code === 'code_mismatch') {
              // Inline, beside the field, in the words main used: the person
              // is mid-typing and a toast would be over their shoulder.
              setCodeError(result.message)
              setCodeState('')
              return
            }
            // `request_not_found` is an answer, not an exception — answered
            // elsewhere or lapsed under the cursor — and swallowing it would
            // leave a person who pressed Allow believing they had paired.
            showToast({ tone: 'error', title: 'Could not approve the pair request', description: result.message })
          }
        } else await window.api.tailnetDenyPairRequest(requestId)
        // The push channel clears the surface everywhere; nothing to do locally.
      } catch (error) {
        showToast({
          tone: 'error',
          title: kind === 'allow' ? 'Could not approve the pair request' : 'Could not decline the pair request',
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, code, requestId],
  )

  return { code, setCode, codeError, busy, answer }
}
