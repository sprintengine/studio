import React, { useEffect, useRef, useState } from 'react'
import { Tooltip, type TooltipChildProps } from './Tooltip'

type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

type TruncatedTextTag = 'p' | 'div' | 'span' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

type TruncatedTextProps = {
  /** The full text. Shown truncated; revealed in a tooltip only when clipped. */
  text: string
  /**
   * Tag to render. Defaults to a block-level paragraph so `truncate` applies.
   * Heading tags are supported so adopting this at a heading site keeps its
   * semantics instead of flattening it to a `div`.
   */
  as?: TruncatedTextTag
  /** Extra classes for the text element (the `truncate` class is always added). */
  className?: string
  /** Preferred tooltip side. */
  placement?: TooltipPlacement
  /**
   * Forwarded to the rendered element. Needed at heading sites whose `id` is
   * referenced by an `aria-labelledby` elsewhere — adopt without dropping the
   * label wiring. The id stays on the inner element even when wrapped in the
   * overflow tooltip, so the reference still resolves.
   */
  id?: string
  /**
   * Opt into multi-line clamping. The component no longer injects `truncate`
   * (single-line) — the caller supplies their own `line-clamp-N` class in
   * `className` — and overflow is measured by HEIGHT (`scrollHeight >
   * clientHeight`) so the tooltip appears only when the clamp actually hides a
   * line. Use for blurbs/descriptions that wrap to a fixed number of lines.
   */
  multiline?: boolean
}

// Text that ellipsis-truncates and surfaces the full string in a tooltip ONLY
// when it is actually clipped — so non-overflowing text never gets a redundant
// tooltip. Single-line (default) injects `truncate` and measures width;
// `multiline` defers to the caller's `line-clamp-N` class and measures height.
// Either way it re-checks on resize (the container, the element, and the
// window). Use anywhere a label or description sits in a constrained box and
// can show "…".
export function TruncatedText({
  text,
  as = 'p',
  className,
  placement = 'top',
  id,
  multiline = false,
}: TruncatedTextProps) {
  const ref = useRef<HTMLElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      // Flipping `overflowing` swaps the rendered root (bare element <-> Tooltip
      // wrapper), which REMOUNTS the host node. Always measure the live node via
      // the ref, and drop observations of the detached old node — its final 0x0
      // reading would otherwise reset the state right back to false.
      const node = ref.current
      if (!node || !node.isConnected) return
      // +1 guards against sub-pixel rounding reporting a false overflow.
      setOverflowing(
        multiline
          ? node.scrollHeight > node.clientHeight + 1
          : node.scrollWidth > node.clientWidth + 1,
      )
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    window.addEventListener('resize', check)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', check)
    }
    // `overflowing` is deliberately a dep: after the wrap/unwrap remount the
    // observer must re-attach to the NEW host node, or it silently watches the
    // detached one and never fires again. setOverflowing with an unchanged value
    // schedules no re-render, so this cannot loop.
  }, [text, multiline, overflowing])

  const element = React.createElement(as, {
    ref,
    id,
    // Single-line owns the `truncate` idiom; multi-line leaves clamping to the
    // caller's `line-clamp-N` class so the line count stays explicit at the site.
    className: [multiline ? null : 'truncate', className].filter(Boolean).join(' '),
    children: text,
  }) as React.ReactElement<TooltipChildProps>

  if (!overflowing) return element

  return (
    <Tooltip
      content={text}
      placement={placement}
      wrapperClassName={multiline ? 'block min-w-0' : 'flex min-w-0'}
    >
      {element}
    </Tooltip>
  )
}

export default TruncatedText
