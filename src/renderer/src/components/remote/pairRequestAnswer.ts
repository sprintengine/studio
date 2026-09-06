import React from 'react'

import type { TailnetScope } from '../../../../shared/tailnet'
import { showToast } from '../../store/toastStore'

// Answering a pair request, in one place: the scope vocabulary, the code
// normaliser, and the IPC round trip with its inline-mismatch rule. Two
// surfaces answer now — the full card (the Remote popover and Settings →
// Remote) and the toast the request arrives as (owner ruling 2026-09-05) —
// and neither may drift from the other on what a wrong code does.

// The scope choices, in the mockup's four combined rows: operate implies read
// within a family (shared/tailnet's own rule), so one checkbox per family
// grants the pair, and the terminal tier — arbitrary shell — stays its own
// named line, never bundled and never pre-ticked.
export const PAIR_SCOPE_ROWS: Array<{ label: string; scopes: TailnetScope[]; note?: string; defaultOn: boolean }> = [
  { label: 'Workspaces — read & operate', scopes: ['workspace:read', 'workspace:operate'], defaultOn: true },
  { label: 'Sprints — read & operate', scopes: ['sprint:read', 'sprint:operate'], defaultOn: true },
  { label: 'Backlog — read & operate', scopes: ['backlog:read', 'backlog:operate'], defaultOn: true },
  { label: 'Terminals — control', scopes: ['terminal:observe', 'terminal:control'], note: 'arbitrary shell', defaultOn: false },
]

/**
 * What an answer given WITHOUT the checkboxes grants — the toast's Allow, and
 * the picker's outbound offer. Terminal control is absent by the same rule
 * that leaves it unticked on the card: arbitrary shell is never granted by a
 * surface that did not show the words.
 */
export const DEFAULT_PAIR_SCOPES: TailnetScope[] = PAIR_SCOPE_ROWS.filter((row) => row.defaultOn).flatMap(
  (row) => row.scopes
)

/** Digits only, at most six: "481 972" read off a screen is the same answer as "481972". */
export function normalizeTypedCode(value: string): string {
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
    [busy, code, requestId]
  )

  return { code, setCode, codeError, busy, answer }
}
