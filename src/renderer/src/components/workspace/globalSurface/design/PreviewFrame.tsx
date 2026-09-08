import { useCallback, useEffect, useRef, useState } from 'react'

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
// reserves a height, so nothing jumps when a frame arrives.
//
// **Why it can measure itself.** The canvas is a specimen sheet now, not a grid
// of uniform tiles: a component's demo is 90px and a pattern's is three
// thousand, and a caller-supplied constant either clips the second or wastes a
// screen on the first. So `height` is a RESERVATION and `sizeToContent` lets the
// frame correct it to what the document actually is, once loaded.

/** How far outside the viewport a preview starts loading. */
const PRELOAD_MARGIN = '400px'

/** Never smaller than this, however little the document turns out to hold. */
const MIN_MEASURED_HEIGHT = 48

export function PreviewFrame({
  srcDoc,
  height,
  title,
  className,
  sizeToContent = false,
}: {
  /** A complete, self-contained document from `composePreviewSrcDoc`. */
  srcDoc: string
  /**
   * The height to reserve. Fixed unless `sizeToContent` is set, in which case it
   * is what the frame occupies until it has measured itself — and what it keeps
   * if it never can.
   */
  height: number
  /** Accessible name — a frame without one is an unlabelled landmark. */
  title: string
  className?: string
  /**
   * Size the frame to its content once it has loaded.
   *
   * This is the one thing that costs something: measuring a document means
   * reading it, which means the frame has to share this document's origin, so
   * the sandbox goes from `""` to `"allow-same-origin"`. It is the smallest
   * relaxation that answers the question, and the preview stays inert in two
   * independent ways without it: `allow-scripts` is still absent, so nothing in
   * the document can run, and the composed document still carries
   * `default-src 'none'`, so nothing in it can be fetched. What it loses is the
   * opaque origin — which only matters against a document that can execute.
   *
   * Callers that want a UNIFORM box (the create screen's cards, where a grid
   * that reflowed per card would be the defect) leave this off and keep the
   * empty sandbox.
   */
  sizeToContent?: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [measured, setMeasured] = useState<number | null>(null)

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

  // A new document is a new height: drop the old measurement rather than
  // holding the previous component's box while the next one loads.
  useEffect(() => {
    setMeasured(null)
  }, [srcDoc])

  const measure = useCallback(() => {
    if (!sizeToContent) return
    const frame = frameRef.current
    // Same-origin only (see `sizeToContent`); a cross-origin read throws, and a
    // frame we cannot measure simply keeps its reservation.
    let body: HTMLElement | null = null
    try {
      body = frame?.contentDocument?.body ?? null
    } catch {
      body = null
    }
    if (!body) return
    // The BODY box, never `documentElement.scrollHeight`: the root element can
    // never report less than the viewport it is laid out in, so measuring it
    // only ever grows the reservation and never shrinks it.
    const next = Math.ceil(body.getBoundingClientRect().height)
    if (!Number.isFinite(next) || next <= 0) return
    setMeasured((current) => {
      const clamped = Math.max(MIN_MEASURED_HEIGHT, next)
      // 1px slack: sub-pixel layout would otherwise re-render on every observer
      // callback, and a frame that resizes forever is worse than one that is a
      // pixel out.
      return current !== null && Math.abs(current - clamped) <= 1 ? current : clamped
    })
  }, [sizeToContent])

  // Late layout — a webfont arriving, an image decoding — changes the height
  // after `load`. Watching the frame's own body is how the correction lands
  // without polling; a frame that never resizes never calls back.
  useEffect(() => {
    if (!sizeToContent || !visible) return
    if (typeof ResizeObserver !== 'function') return
    const frame = frameRef.current
    let body: HTMLElement | null = null
    try {
      body = frame?.contentDocument?.body ?? null
    } catch {
      body = null
    }
    if (!body) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(body)
    return () => observer.disconnect()
    // `measured` is a real dependency, not a stray one: loading a srcDoc
    // REPLACES the frame's document, so the body observed before `load` is not
    // the body that ends up on screen. Re-running once the first measurement
    // lands re-attaches the observer to the document that is actually there.
  }, [sizeToContent, visible, srcDoc, measure, measured])

  return (
    <div ref={hostRef} className={className} style={{ height: measured ?? height }}>
      {visible ? (
        <iframe
          ref={frameRef}
          // Scripts are off either way — `allow-scripts` is never passed — and
          // the composed document carries `default-src 'none'` on top of that.
          // The empty sandbox additionally denies the frame this document's
          // origin; `allow-same-origin` is granted only to a frame the caller
          // needs to measure, because reading a height means reading the
          // document. See `sizeToContent`.
          sandbox={sizeToContent ? 'allow-same-origin' : ''}
          srcDoc={srcDoc}
          title={title}
          loading="lazy"
          onLoad={measure}
          className="h-full w-full border-0 bg-transparent"
          // A preview is content the user reads, not a control they operate:
          // scrolling inside a specimen would swallow the page's own scroll.
          scrolling="no"
        />
      ) : null}
    </div>
  )
}
