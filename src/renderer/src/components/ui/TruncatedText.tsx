import React, { useEffect, useRef, useState } from 'react'
import { Tooltip, type TooltipChildProps } from './Tooltip'

type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

type TruncatedTextProps = {
  /** The full text. Shown truncated; revealed in a tooltip only when clipped. */
  text: string
  /** Tag to render. Defaults to a block-level paragraph so `truncate` applies. */
  as?: 'p' | 'div' | 'span'
  /** Extra classes for the text element (the `truncate` class is always added). */
  className?: string
  /** Preferred tooltip side. */
  placement?: TooltipPlacement
}

// Single-line text that ellipsis-truncates, and surfaces the full string in a
// tooltip ONLY when it is actually clipped — so non-overflowing text never gets
// a redundant tooltip. Measures via scrollWidth > clientWidth and re-checks on
// resize (the container, the element, and the window). Use anywhere a label or
// description sits in a constrained width and can show "…".
export function TruncatedText({
  text,
  as = 'p',
  className,
  placement = 'top',
}: TruncatedTextProps) {
  const ref = useRef<HTMLElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      // +1 guards against sub-pixel rounding reporting a false overflow.
      setOverflowing(el.scrollWidth > el.clientWidth + 1)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    window.addEventListener('resize', check)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', check)
    }
  }, [text])

  const element = React.createElement(as, {
    ref,
    className: ['truncate', className].filter(Boolean).join(' '),
    children: text,
  }) as React.ReactElement<TooltipChildProps>

  if (!overflowing) return element

  return (
    <Tooltip content={text} placement={placement} wrapperClassName="flex min-w-0">
      {element}
    </Tooltip>
  )
}

export default TruncatedText
