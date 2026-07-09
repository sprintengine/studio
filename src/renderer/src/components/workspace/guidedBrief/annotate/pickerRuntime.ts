// The inspector/picker that runs *inside* the sandboxed frame under
// `allow-scripts`. It is injected as source text (the frame is an opaque origin
// and cannot import from the parent bundle), so `buildAnnotatePickerSource`
// serializes these functions with `Function.prototype.toString()` and
// concatenates them into one IIFE. That is safe because every function below is
// self-contained — it references only its arguments, standard JS, DOM globals,
// and the *other functions in this same bundle*. A bundler renames a declaration
// and all its references to the same identifier within one bundle, so the
// serialized declarations and call-sites stay consistent even when minified.

import { ANNOTATE_MESSAGE_CHANNEL } from './bridge'
import { buildSnippetExcerpt, buildUniqueSelector, describeElementChip, type SelectorNode } from './selector'

type PickerConfig = { channel: string }

// Reduce a live element (and its ancestor chain) to the structural SelectorNode
// the pure builder consumes. Recurses to the root so the selector chain is
// complete; nth-of-type is computed by scanning same-tag siblings.
function elementToSelectorNode(el: Element): SelectorNode {
  const parentEl = el.parentElement
  let nthOfType = 1
  let typeSiblingCount = 0
  if (parentEl) {
    const siblings = parentEl.children
    for (let i = 0; i < siblings.length; i += 1) {
      const sibling = siblings[i]
      if (sibling.tagName === el.tagName) {
        typeSiblingCount += 1
        if (sibling === el) nthOfType = typeSiblingCount
      }
    }
  } else {
    typeSiblingCount = 1
  }
  return {
    tagName: el.tagName,
    id: el.id || null,
    classNames: Array.from(el.classList),
    parent: parentEl ? elementToSelectorNode(parentEl) : null,
    nthOfType,
    typeSiblingCount,
  }
}

// Installed once when the frame loads. Draws a hover outline + identity chip
// inside the frame and reports hover/selection out to the parent via
// postMessage. Selection reporting is un-scaled (frame-viewport rect + scroll);
// the parent applies the zoom/offset transform (see bridge). It also answers
// the parent's `locate` requests with current page-coord rects (null when a
// selector no longer matches), re-answers after in-frame resizes (a zoom or
// viewport change reflows the document), and streams scroll offsets — the
// three signals that keep parent-rendered pins glued to their elements.
function installAnnotatePicker(config: PickerConfig): void {
  const channel = config.channel
  const doc = document
  const highlight = doc.createElement('div')
  highlight.setAttribute('data-annotate-highlight', 'true')
  // Picker chrome paints inside the opaque-origin sandboxed frame, which cannot
  // reach the app's CSS custom properties — literal colors are unavoidable here.
  highlight.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483646;display:none;box-sizing:border-box;' +
    'border:1.5px solid #4c6ef5;border-radius:3px;background:rgba(76,110,245,0.14);' // design-tokens-allow: sandboxed frame chrome, app tokens unreachable
  const chip = doc.createElement('div')
  chip.setAttribute('data-annotate-chip', 'true')
  chip.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;display:none;max-width:90vw;overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'background:#1a1b1e;color:#e9ecef;padding:2px 6px;border-radius:4px;' // design-tokens-allow: sandboxed frame chrome, app tokens unreachable

  const mount = (): void => {
    if (!doc.body) return
    doc.body.appendChild(highlight)
    doc.body.appendChild(chip)
  }
  if (doc.body) mount()
  else doc.addEventListener('DOMContentLoaded', mount, { once: true })

  const post = (message: Record<string, unknown>): void => {
    // targetOrigin '*' is acceptable: the payload carries no secrets and the
    // parent authenticates by source identity, not origin.
    window.parent.postMessage({ ...message, channel }, '*')
  }

  const frameRect = (el: Element): { x: number; y: number; width: number; height: number } => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  const isOwnChrome = (el: Element | null): boolean => el === highlight || el === chip

  const onMove = (event: MouseEvent): void => {
    const el = event.target
    if (!(el instanceof Element) || isOwnChrome(el)) return
    const node = elementToSelectorNode(el)
    const rect = el.getBoundingClientRect()
    highlight.style.display = 'block'
    highlight.style.left = `${rect.left}px`
    highlight.style.top = `${rect.top}px`
    highlight.style.width = `${rect.width}px`
    highlight.style.height = `${rect.height}px`
    const label = describeElementChip(node, el.textContent || '')
    chip.textContent = label
    chip.style.display = 'block'
    chip.style.left = `${rect.left}px`
    chip.style.top = `${Math.max(0, rect.top - 20)}px`
    post({
      type: 'hover',
      selector: buildUniqueSelector(node),
      tagName: el.tagName.toLowerCase(),
      chip: label,
      rect: frameRect(el),
    })
  }

  const clearHover = (): void => {
    highlight.style.display = 'none'
    chip.style.display = 'none'
    post({ type: 'hover-end' })
  }

  const onClick = (event: MouseEvent): void => {
    const el = event.target
    if (!(el instanceof Element) || isOwnChrome(el)) return
    // Suppress the author page's own click behavior while picking.
    event.preventDefault()
    event.stopPropagation()
    const node = elementToSelectorNode(el)
    post({
      type: 'select',
      selector: buildUniqueSelector(node),
      tagName: el.tagName.toLowerCase(),
      snippet: buildSnippetExcerpt(el.outerHTML),
      rect: frameRect(el),
      scrollOffset: { x: window.scrollX, y: window.scrollY },
    })
  }

  // --- Anchor tracking: locate requests, scroll offsets, resize re-reports ---

  const pageRect = (el: Element): { x: number; y: number; width: number; height: number } => {
    const r = el.getBoundingClientRect()
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
  }

  let locatedSelectors: string[] = []

  const postAnchors = (): void => {
    const anchors = locatedSelectors.map((selector) => {
      let el: Element | null = null
      try {
        el = doc.querySelector(selector)
      } catch {
        el = null // an invalid selector is simply unanchored, never a crash
      }
      return { selector, rect: el ? pageRect(el) : null }
    })
    post({ type: 'anchors', anchors, scrollOffset: { x: window.scrollX, y: window.scrollY } })
  }

  // Captured at document level so nested scrollable containers report too. A
  // nested scroll moves elements without changing window.scroll, so fresh
  // anchors (not just the offset) are what keep pins glued; the plain scroll
  // offset still updates the parent's projection of a not-yet-pinned draft.
  let scrollFrame = 0
  const onScroll = (): void => {
    if (scrollFrame) return
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0
      post({ type: 'scroll', scrollOffset: { x: window.scrollX, y: window.scrollY } })
      if (locatedSelectors.length > 0) postAnchors()
    })
  }

  let resizeFrame = 0
  const onResize = (): void => {
    if (resizeFrame) return
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0
      if (locatedSelectors.length > 0) postAnchors()
    })
  }

  // Only the embedding parent window is trusted, mirroring the parent's own
  // source-identity check; anything else (including our own frame) is ignored.
  const onParentMessage = (event: MessageEvent): void => {
    if (event.source !== window.parent) return
    const data = event.data as { channel?: unknown; type?: unknown; selectors?: unknown } | null
    if (!data || typeof data !== 'object') return
    if (data.channel !== channel || data.type !== 'locate') return
    if (!Array.isArray(data.selectors)) return
    locatedSelectors = data.selectors.filter((entry): entry is string => typeof entry === 'string')
    postAnchors()
  }

  doc.addEventListener('mousemove', onMove, true)
  doc.addEventListener('mouseleave', clearHover, true)
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('message', onParentMessage)
  post({ type: 'ready' })
}

// Functions serialized into the injected IIFE. Order matters only for
// readability — declarations hoist. `installAnnotatePicker` is invoked via its
// runtime `.name` so the call matches its (possibly minified) declaration.
const INJECTED_FUNCTIONS = [
  buildUniqueSelector,
  buildSnippetExcerpt,
  describeElementChip,
  elementToSelectorNode,
  installAnnotatePicker,
]

/**
 * The self-contained JavaScript injected into annotate-mode srcDoc. Contains no
 * `</script>` sequence, so it embeds safely in a script element. The parent
 * validates every message this emits (see bridge), and it never receives
 * `allow-same-origin`, so it cannot reach the parent DOM.
 */
export function buildAnnotatePickerSource(): string {
  const declarations = INJECTED_FUNCTIONS.map((fn) => fn.toString()).join('\n')
  const config = JSON.stringify({ channel: ANNOTATE_MESSAGE_CHANNEL })
  return `(function(){\n${declarations}\n${installAnnotatePicker.name}(${config});\n})();`
}
