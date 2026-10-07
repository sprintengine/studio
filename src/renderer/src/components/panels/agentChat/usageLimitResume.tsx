// The composer tray's row for a chat a usage limit stopped: which limit, when
// it resets, and Resume at reset, which has Studio send the chat a short "carry
// on" once it has. With the resume scheduled the row says when it goes out,
// and Cancel takes it back. Main keeps the resumes and sends them
// (src/main/usage-limits/resume.ts); this only draws one chat's.

import { memo, useEffect, type JSX } from 'react'

import { useRelativeNow } from '../../../hooks/useRelativeNow'
import {
  retainUsageLimitResumes,
  selectUsageLimitResumeNotice,
  updateUsageLimitResume,
  useUsageLimitResumeStore,
} from '../../../store/usageLimitResumeStore'
import type { UsageLimitResumeNotice } from '../../../../../shared/usage-limit-resume'
import { formatUsageResetIn, usageProviderLabel } from '../../../../../shared/usage-limits'
import { GhostButton, LinkButton } from '../../ui'
import { ComposerTrayRow } from './composerTray'

const DAY_MS = 24 * 60 * 60 * 1000

/** "23:40" today, "Fri 23:40" within the week, "12 Oct, 23:40" beyond it. */
export function formatResumeClock(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === new Date(now).toDateString()) return time
  if (at - now < 6 * DAY_MS) return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
}

/** The notice in words: "Claude's session limit is used up. It resets at 23:40 (in 2h 13m)." */
export function usageLimitResumeWords(notice: UsageLimitResumeNotice, now: number): string {
  const limit =
    notice.limit === 'session' ? 'session limit' : notice.limit === 'weekly' ? 'weekly limit' : 'usage limit'
  const head = `${usageProviderLabel(notice.provider)}'s ${limit} is used up.`
  if (notice.resumeAt !== null)
    return `${head} Resumes at ${formatResumeClock(notice.resumeAt, now)} (in ${formatUsageResetIn(notice.resumeAt, now)}).`
  if (notice.resetsAt !== null)
    return `${head} It resets at ${formatResumeClock(notice.resetsAt, now)} (in ${formatUsageResetIn(notice.resetsAt, now)}).`
  return `${head} It did not say when it resets.`
}

function UsageLimitResumeRowBody({
  workspaceId,
  agentId,
}: {
  workspaceId: string
  agentId: string
}): JSX.Element | null {
  useEffect(() => retainUsageLimitResumes(), [])
  const notice = useUsageLimitResumeStore((store) =>
    selectUsageLimitResumeNotice(store.state, { workspaceId, agentId }),
  )
  const autoResume = useUsageLimitResumeStore((store) => store.state?.autoResume ?? false)
  // A minute's resolution: the words count down in minutes.
  const now = useRelativeNow(30_000, notice !== null)
  if (!notice) return null
  // Nothing scheduled and the limit has reset: the notice is no longer true.
  if (notice.resumeAt === null && notice.resetsAt !== null && notice.resetsAt <= now) return null
  const chat = { workspaceId, agentId }
  const words = usageLimitResumeWords(notice, now)

  if (notice.resumeAt !== null) {
    return (
      <ComposerTrayRow
        tone="neutral"
        actions={
          <GhostButton size="xs" onClick={() => void updateUsageLimitResume({ kind: 'cancel', ...chat })}>
            Cancel
          </GhostButton>
        }
      >
        {words}
      </ComposerTrayRow>
    )
  }

  const canSchedule = notice.resetsAt !== null
  return (
    <ComposerTrayRow
      tone="warn"
      actions={
        <>
          {canSchedule ? (
            <GhostButton size="xs" onClick={() => void updateUsageLimitResume({ kind: 'schedule', ...chat })}>
              Resume at reset
            </GhostButton>
          ) : null}
          <GhostButton size="xs" onClick={() => void updateUsageLimitResume({ kind: 'dismiss', ...chat })}>
            Dismiss
          </GhostButton>
        </>
      }
    >
      {words}
      {canSchedule && !autoResume ? (
        <>
          {' '}
          <LinkButton
            onClick={() => {
              void (async () => {
                await updateUsageLimitResume({ kind: 'auto', enabled: true })
                await updateUsageLimitResume({ kind: 'schedule', ...chat })
              })()
            }}
          >
            Always resume at reset
          </LinkButton>
        </>
      ) : null}
    </ComposerTrayRow>
  )
}

// Memoised: the chat body commits on every streamed token, and this row
// changes only when main says so, through its store.
export const UsageLimitResumeRow = memo(UsageLimitResumeRowBody)
