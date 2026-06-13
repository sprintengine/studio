import { useEffect, useState } from 'react'
import { Spinner } from '../../ui'
import { GuidedBriefRawTerminal } from './GuidedBriefRawTerminal'
import { InterviewQuestionCard, ResolvedDecisionsList } from './InterviewPane'
import type { GuidedInterviewState } from './interviewProtocol'
import type { GuidedBriefSpecialistSession } from './sessionAdapter'

type Props = {
  session: GuidedBriefSpecialistSession | null
  starting: boolean
  errorMessage: string | null
  specialistName: string
  specialistSubline: string
  working: boolean
  /** Structured interview from the session stream; omit to render terminal-only. */
  interview?: GuidedInterviewState
  /** Writes an answer into the PTY stdin. Required for the question card. */
  onAnswer?: (answerText: string) => void
}

// The terminal is the transport and the fallback, never hidden — only
// demoted. While a structured question is live the card leads and the
// terminal collapses to a bar; with no structured question the terminal is
// the whole surface. The user's explicit show/hide choice wins over both.
type TerminalPreference = 'auto' | 'shown' | 'hidden'

export function ConversationPane({
  session,
  starting,
  errorMessage,
  specialistName,
  specialistSubline,
  working,
  interview,
  onAnswer,
}: Props) {
  const [terminalPreference, setTerminalPreference] = useState<TerminalPreference>('auto')
  const [answeredQuestionId, setAnsweredQuestionId] = useState<string | null>(null)

  const question = working ? interview?.currentQuestion ?? null : null
  const interviewActive = Boolean(question && onAnswer && session)

  // The pending lock clears as soon as the stream resolves or replaces the
  // question — the card state is always derived from the parse, never local.
  useEffect(() => {
    if (!question) {
      setAnsweredQuestionId(null)
      return
    }
    setAnsweredQuestionId((current) => (current === question.id ? current : null))
  }, [question])

  const terminalVisible =
    terminalPreference === 'shown' || (terminalPreference === 'auto' && !interviewActive)

  const answer = (text: string) => {
    if (!question || !onAnswer) return
    setAnsweredQuestionId(question.id)
    onAnswer(text)
  }

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
          <>
            {interviewActive && question ? (
              <div
                className={`flex flex-col overflow-y-auto ${
                  terminalVisible ? 'max-h-[45%] shrink-0' : 'min-h-0 flex-1'
                }`}
              >
                <ResolvedDecisionsList decisions={interview?.decisions ?? []} />
                <InterviewQuestionCard
                  question={question}
                  onAnswer={answer}
                  answerPending={answeredQuestionId === question.id}
                />
              </div>
            ) : null}
            <div
              className={
                terminalVisible ? 'flex min-h-0 flex-1 flex-col' : 'h-0 overflow-hidden'
              }
            >
              <GuidedBriefRawTerminal sessionId={session.sessionId} className="px-3 py-2" />
            </div>
            {interviewActive ? (
              <div className="flex shrink-0 items-center gap-2 border-t border-[color:var(--border-subtle)] px-3 py-1.5">
                <span className="truncate font-mono text-[11px] text-[color:var(--text-subtle)]">
                  Terminal · live
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setTerminalPreference(terminalVisible ? 'hidden' : 'shown')
                  }
                  className="
                    ml-auto inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--text-muted)]
                    transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                  "
                >
                  {terminalVisible ? 'Hide' : 'Show'}
                </button>
              </div>
            ) : null}
          </>
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
