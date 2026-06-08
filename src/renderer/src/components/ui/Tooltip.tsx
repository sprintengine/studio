import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

export type TooltipChildProps = {
  'aria-describedby'?: string
  onMouseEnter?: (event: React.MouseEvent) => void
  onMouseLeave?: (event: React.MouseEvent) => void
  onFocus?: (event: React.FocusEvent) => void
  onBlur?: (event: React.FocusEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}

type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

type TooltipProps = {
  /** Short helper text or rich node shown beside the trigger. */
  content: React.ReactNode
  /**
   * Preferred side relative to the trigger. The tooltip flips to the opposite
   * side when the preferred side would overflow the viewport, then clamps to
   * the viewport on both axes, so it is never cropped at a screen edge. `right`
   * suits narrow vertical chrome (e.g. a collapsed sidebar rail).
   */
  placement?: TooltipPlacement
  /** A single focusable trigger. The tooltip clones it to wire ARIA + handlers. */
  children: React.ReactElement<TooltipChildProps>
  /** Hover open delay. Focus opens immediately so keyboard users do not wait. */
  openDelayMs?: number
  className?: string
  /**
   * Classes applied to the wrapping span around the trigger. Use this when the
   * default `inline-flex` would shrink the trigger to its content — e.g. a
   * drop-target button inside a flex column that should fill the row.
   */
  wrapperClassName?: string
}

// Gap between the trigger and the tooltip, and the minimum margin the tooltip
// keeps from every viewport edge.
const TRIGGER_GAP = 6
const VIEWPORT_PADDING = 8

const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

// Viewport-relative (position: fixed) coordinates for the tooltip. The tooltip
// renders in a body portal so it escapes any `overflow` clipping from an
// ancestor (e.g. the scrollable sidebar nav), then flips + clamps so it can
// never be cropped at a viewport edge.
function computeTooltipCoords(
  triggerRect: DOMRect,
  tip: { width: number; height: number },
  preferred: TooltipPlacement,
): { top: number; left: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight

  const candidates: Record<TooltipPlacement, { top: number; left: number }> = {
    top: {
      top: triggerRect.top - tip.height - TRIGGER_GAP,
      left: triggerRect.left + triggerRect.width / 2 - tip.width / 2,
    },
    bottom: {
      top: triggerRect.bottom + TRIGGER_GAP,
      left: triggerRect.left + triggerRect.width / 2 - tip.width / 2,
    },
    left: {
      top: triggerRect.top + triggerRect.height / 2 - tip.height / 2,
      left: triggerRect.left - tip.width - TRIGGER_GAP,
    },
    right: {
      top: triggerRect.top + triggerRect.height / 2 - tip.height / 2,
      left: triggerRect.right + TRIGGER_GAP,
    },
  }

  // Does the candidate stay on-screen along the axis it points from?
  const fitsMainAxis = (side: TooltipPlacement): boolean => {
    const c = candidates[side]
    if (side === 'top') return c.top >= VIEWPORT_PADDING
    if (side === 'bottom') return c.top + tip.height <= vh - VIEWPORT_PADDING
    if (side === 'left') return c.left >= VIEWPORT_PADDING
    return c.left + tip.width <= vw - VIEWPORT_PADDING
  }

  // Flip to the opposite side only when the preferred side overflows and the
  // opposite side fits; otherwise keep the preferred side and rely on clamping.
  let side = preferred
  if (!fitsMainAxis(side) && fitsMainAxis(OPPOSITE[side])) {
    side = OPPOSITE[side]
  }

  const chosen = candidates[side]
  const maxLeft = Math.max(VIEWPORT_PADDING, vw - tip.width - VIEWPORT_PADDING)
  const maxTop = Math.max(VIEWPORT_PADDING, vh - tip.height - VIEWPORT_PADDING)
  return {
    top: Math.min(Math.max(chosen.top, VIEWPORT_PADDING), maxTop),
    left: Math.min(Math.max(chosen.left, VIEWPORT_PADDING), maxLeft),
  }
}

export function Tooltip({
  content,
  placement = 'top',
  children,
  openDelayMs = 200,
  className,
  wrapperClassName,
}: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<number | null>(null)
  const triggerWrapRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

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

  const position = useCallback(() => {
    const wrap = triggerWrapRef.current
    const tip = tooltipRef.current
    if (!wrap || !tip) return
    setCoords(
      computeTooltipCoords(
        wrap.getBoundingClientRect(),
        { width: tip.offsetWidth, height: tip.offsetHeight },
        placement,
      ),
    )
  }, [placement])

  // Measure before paint, and keep the tooltip pinned to its trigger while open
  // (scroll uses capture so nested scroll containers are caught too).
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    position()
    const reposition = () => position()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, position])

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
    <span ref={triggerWrapRef} className={`relative ${wrapperClassName ?? 'inline-flex'}`}>
      {trigger}
      {open
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              id={id}
              style={{
                position: 'fixed',
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                // Hidden until measured so the first paint never flashes at 0,0.
                visibility: coords ? 'visible' : 'hidden',
              }}
              className={[
                'popover-enter pointer-events-none z-50',
                'whitespace-nowrap rounded-[5px] border border-[color:var(--border-strong)]',
                'bg-[color:var(--bg-surface-raised)] px-2 py-1',
                'text-[11px] leading-snug text-[color:var(--text-strong)]',
                className ?? '',
              ].join(' ')}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
