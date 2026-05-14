import React, { useCallback, useEffect, useId, useRef, useState } from 'react'

type TooltipChildProps = {
  'aria-describedby'?: string
  onMouseEnter?: (event: React.MouseEvent) => void
  onMouseLeave?: (event: React.MouseEvent) => void
  onFocus?: (event: React.FocusEvent) => void
  onBlur?: (event: React.FocusEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}

type TooltipProps = {
  /** Short helper text or rich node shown above/below the trigger. */
  content: React.ReactNode
  placement?: 'top' | 'bottom'
  /** A single focusable trigger. The tooltip clones it to wire ARIA + handlers. */
  children: React.ReactElement<TooltipChildProps>
  /** Hover open delay. Focus opens immediately so keyboard users do not wait. */
  openDelayMs?: number
  className?: string
}

export function Tooltip({
  content,
  placement = 'top',
  children,
  openDelayMs = 200,
  className,
}: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const close = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  useEffect(() => clearTimer, [clearTimer])

  const childProps = children.props

  const handleMouseEnter = useCallback(
    (event: React.MouseEvent) => {
      childProps.onMouseEnter?.(event)
      clearTimer()
      timer.current = window.setTimeout(() => setOpen(true), openDelayMs)
    },
    [childProps, clearTimer, openDelayMs],
  )

  const handleMouseLeave = useCallback(
    (event: React.MouseEvent) => {
      childProps.onMouseLeave?.(event)
      close()
    },
    [childProps, close],
  )

  const handleFocus = useCallback(
    (event: React.FocusEvent) => {
      childProps.onFocus?.(event)
      clearTimer()
      setOpen(true)
    },
    [childProps, clearTimer],
  )

  const handleBlur = useCallback(
    (event: React.FocusEvent) => {
      childProps.onBlur?.(event)
      close()
    },
    [childProps, close],
  )

  const trigger = React.cloneElement<TooltipChildProps>(children, {
    'aria-describedby': open ? id : childProps['aria-describedby'],
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
  })

  return (
    <span className="relative inline-flex">
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={[
            'popover-enter pointer-events-none absolute left-1/2 z-30 -translate-x-1/2',
            placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
            'whitespace-nowrap rounded-[5px] border border-[color:var(--border-strong)]',
            'bg-[color:var(--bg-surface-raised)] px-2 py-1',
            'text-[11px] leading-snug text-[color:var(--text-strong)]',
            className ?? '',
          ].join(' ')}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}
