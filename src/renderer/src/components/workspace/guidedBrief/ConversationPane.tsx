import { Spinner } from '../../ui'
import { GuidedBriefRawTerminal } from './GuidedBriefRawTerminal'
import type { GuidedBriefSpecialistSession } from './sessionAdapter'

type Props = {
  session: GuidedBriefSpecialistSession | null
  starting: boolean
  errorMessage: string | null
  specialistName: string
  specialistSubline: string
  working: boolean
}

export function ConversationPane({
  session,
  starting,
  errorMessage,
  specialistName,
  specialistSubline,
  working,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
        >
          <svg viewBox="0 0 24 24" fill="none" className="icon-md">
            <circle cx="12" cy="9" r="3" stroke="currentColor" strokeWidth="1.6" />
            <path d="M5 19c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
            {specialistName}
          </span>
          <span className="truncate text-[12px] text-[color:var(--text-muted)]">
            {specialistSubline}
          </span>
        </div>
        {working && session && !errorMessage ? <Spinner size={14} label="Working" /> : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)]">
        {session ? (
          <GuidedBriefRawTerminal sessionId={session.sessionId} className="px-3 py-2" />
        ) : (
          <RawPlaceholder
            specialistName={specialistName}
            starting={starting}
            errorMessage={errorMessage}
          />
        )}
      </div>
    </div>
  )
}

function RawPlaceholder({
  specialistName,
  starting,
  errorMessage,
}: {
  specialistName: string
  starting: boolean
  errorMessage: string | null
}) {
  if (errorMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="text-[12px] font-semibold text-[color:var(--tone-error)]">
          {specialistName} session unavailable
        </span>
        <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">{errorMessage}</span>
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
      {starting
        ? `Starting the ${specialistName.toLowerCase()} session…`
        : `${specialistName} is not connected.`}
    </div>
  )
}
