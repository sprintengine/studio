import { useEffect, useRef } from 'react'
import type { ConversationTurn } from './parseStream'

type Props = {
  specialistName: string
  starting: boolean
  errorMessage: string | null
  turns: ConversationTurn[]
}

export function ParsedConversationView({
  specialistName,
  starting,
  errorMessage,
  turns,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to the latest turn as new content arrives. We do not animate
  // the scroll — abrupt jumps are fine because new content always lands at
  // the bottom of the visible list.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns])

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

  if (turns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
        {starting
          ? `Starting the ${specialistName.toLowerCase()} session…`
          : `${specialistName} is getting ready.`}
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-4 py-4">
      {turns.map((turn) => (
        <ConversationTurnRow key={turn.id} turn={turn} specialistName={specialistName} />
      ))}
    </div>
  )
}

function ConversationTurnRow({
  turn,
  specialistName,
}: {
  turn: ConversationTurn
  specialistName: string
}) {
  const label = turn.speaker === 'user' ? 'You' : specialistName
  const labelTone =
    turn.speaker === 'user'
      ? 'text-[color:var(--tone-good)]'
      : 'text-[color:var(--accent-primary)]'

  return (
    <div className="flex flex-col gap-1">
      <span className={`text-[11px] font-semibold tracking-tight ${labelTone}`}>{label}</span>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[color:var(--text-strong)]">
        {turn.content}
      </div>
    </div>
  )
}
