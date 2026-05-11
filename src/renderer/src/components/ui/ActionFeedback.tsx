import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, CloseIcon } from '../AppIcons'

export type ActionTone = 'success' | 'error' | 'info'

export type ActionStatus = {
  tone: ActionTone
  message: string
  /** Stable id so re-firing the same action retriggers the chip-enter animation. */
  nonce: number
}

export type ActionStatusMap = Record<string, ActionStatus | null>

const TONE_CLASS: Record<ActionTone, string> = {
  success: 'border-[#234d27] bg-[#0f1d10] text-[#9be39e]',
  error: 'border-[#3a2222] bg-[#1c1414] text-[#ffb3b5]',
  info: 'border-[#2a2b31] bg-[#111216] text-[#d7d7dc]',
}

const AUTO_DISMISS_MS = 4000

export function ActionStatusChip({
  status,
  onDismiss,
  className = '',
}: {
  status: ActionStatus | null
  onDismiss?: () => void
  className?: string
}) {
  if (!status) return null
  const role = status.tone === 'error' ? 'alert' : 'status'
  const ariaLive = status.tone === 'error' ? 'assertive' : 'polite'
  return (
    <span
      key={status.nonce}
      role={role}
      aria-live={ariaLive}
      className={`chip-enter inline-flex max-w-[280px] shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10.5px] leading-4 ${TONE_CLASS[status.tone]} ${className}`}
    >
      {status.tone === 'success' ? (
        <CheckIcon className="h-3 w-3 shrink-0" />
      ) : status.tone === 'error' ? (
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff787c]" />
      ) : (
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#9a9aa2]" />
      )}
      <span className="min-w-0 truncate">{status.message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="interactive ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-current opacity-70 hover:opacity-100"
        >
          <CloseIcon className="h-2.5 w-2.5" />
        </button>
      ) : null}
    </span>
  )
}

/**
 * Hook for managing per-action feedback chips anchored next to the source action.
 * - Success / info auto-dismiss after 4s.
 * - Error stays until manually dismissed (or replaced by another status on the same key).
 */
export function useActionFeedback(): {
  statuses: ActionStatusMap
  notify: (key: string, tone: ActionTone, message: string) => void
  dismiss: (key: string) => void
  clearAll: () => void
} {
  const [statuses, setStatuses] = useState<ActionStatusMap>({})
  const nonceRef = useRef(0)
  const timersRef = useRef<Map<string, number>>(new Map())

  const clearTimer = useCallback((key: string) => {
    const handle = timersRef.current.get(key)
    if (handle !== undefined) {
      window.clearTimeout(handle)
      timersRef.current.delete(key)
    }
  }, [])

  const dismiss = useCallback(
    (key: string) => {
      clearTimer(key)
      setStatuses((current) => {
        if (!current[key]) return current
        return { ...current, [key]: null }
      })
    },
    [clearTimer]
  )

  const notify = useCallback(
    (key: string, tone: ActionTone, message: string) => {
      clearTimer(key)
      nonceRef.current += 1
      const status: ActionStatus = { tone, message, nonce: nonceRef.current }
      setStatuses((current) => ({ ...current, [key]: status }))
      if (tone !== 'error') {
        const handle = window.setTimeout(() => {
          setStatuses((current) => {
            if (current[key]?.nonce !== status.nonce) return current
            return { ...current, [key]: null }
          })
          timersRef.current.delete(key)
        }, AUTO_DISMISS_MS)
        timersRef.current.set(key, handle)
      }
    },
    [clearTimer]
  )

  const clearAll = useCallback(() => {
    timersRef.current.forEach((handle) => window.clearTimeout(handle))
    timersRef.current.clear()
    setStatuses({})
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((handle) => window.clearTimeout(handle))
      timers.clear()
    }
  }, [])

  return { statuses, notify, dismiss, clearAll }
}

/**
 * Hook for managing per-action loading state, keyed so each button can show its
 * own spinner without disabling the whole panel.
 */
export function usePendingActions<K extends string = string>(): {
  pending: Set<K>
  isPending: (key: K) => boolean
  run: <T>(key: K, work: () => Promise<T>) => Promise<T>
} {
  const [pending, setPending] = useState<Set<K>>(() => new Set<K>())

  const isPending = useCallback((key: K) => pending.has(key), [pending])

  const run = useCallback(async <T,>(key: K, work: () => Promise<T>): Promise<T> => {
    setPending((current) => {
      if (current.has(key)) return current
      const next = new Set(current)
      next.add(key)
      return next
    })
    try {
      return await work()
    } finally {
      setPending((current) => {
        if (!current.has(key)) return current
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [])

  return { pending, isPending, run }
}
