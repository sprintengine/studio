import { useEffect, useRef, useState } from 'react'

// One component preview, in its own sandboxed document.
//
// **Why an iframe per preview and not one for the grid.** Scripts stay off, so
// there is no `postMessage` to relay a click out of a shared frame — the app
// would have to duplicate the grid's geometry in an overlay and would lose the
// per-tile hover and hit target. A document per preview also means no
// cross-component CSS rescoping is needed at all (the catalog builder rescopes
// only because it puts every component on ONE page), which removes a whole class
// of "the rescoper missed a selector" bug instead of reimplementing it.
//
// **Why it mounts lazily.** A hundred components would otherwise be a hundred
// live documents. The frame mounts when it first scrolls near the viewport and
// stays mounted after that — unmounting on exit would reload the document every
// time the user scrolled back, which is worse than holding it. The placeholder
// reserves the exact final height, so nothing shifts when a frame arrives.

/** How far outside the viewport a preview starts loading. */
const PRELOAD_MARGIN = '400px'

export function PreviewFrame({
  srcDoc,
  height,
  title,
  className,
}: {
  /** A complete, self-contained document from `composePreviewSrcDoc`. */
  srcDoc: string
  /** Reserved height, so the placeholder and the frame occupy the same box. */
  height: number
  /** Accessible name — a frame without one is an unlabelled landmark. */
  title: string
  className?: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (visible) return
    const host = hostRef.current
    if (!host) return
    // No IntersectionObserver (jsdom, or an old engine): mount immediately
    // rather than never. A missing optimisation must not become missing content.
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: PRELOAD_MARGIN },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [visible])

  return (
    <div ref={hostRef} className={className} style={{ height }}>
      {visible ? (
        <iframe
          // Empty sandbox: scripts off AND no same-origin, so the frame cannot
          // reach this document even though srcDoc would otherwise inherit our
          // origin. The composed document also carries a meta CSP.
          sandbox=""
          srcDoc={srcDoc}
          title={title}
          loading="lazy"
          className="h-full w-full border-0 bg-transparent"
          // A preview is decorative content the user reads, not a control they
          // operate: scrolling inside a 140px tile would swallow page scroll.
          scrolling="no"
        />
      ) : null}
    </div>
  )
}
