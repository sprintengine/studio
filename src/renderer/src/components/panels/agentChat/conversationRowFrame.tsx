import { useEffect, useState, type ReactNode } from 'react'

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
