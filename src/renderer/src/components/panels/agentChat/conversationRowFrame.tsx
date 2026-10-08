import { useEffect, useState, type ReactNode } from 'react'

/** The row attribute the chat's find looks for the match it is on under (conversationFind.ts). */
export const CONVERSATION_ROW_ATTRIBUTE = 'data-conversation-row'

/** Animate arrival once, never a historical page or a recycled mount. */
export function ConversationRowFrame({
  id,
  live,
  seen,
  flash,
  onFlashEnd,
  children,
}: {
  id: string
  live: boolean
  seen: Set<string>
  flash: boolean
  onFlashEnd: () => void
  children: ReactNode
}) {
  const [entering, setEntering] = useState(() => live && !seen.has(id))
  useEffect(() => {
    if (live) seen.add(id)
  }, [id, live, seen])
  return (
    <div
      // Where the chat's find looks for the match it is on (conversationFind.ts).
      {...{ [CONVERSATION_ROW_ATTRIBUTE]: id }}
      className={flash ? 'attention-row-pulse' : entering ? 'conversation-row-enter' : undefined}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return
        setEntering(false)
        if (flash) onFlashEnd()
      }}
    >
      {children}
    </div>
  )
}
