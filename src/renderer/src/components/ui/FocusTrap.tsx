// The one focus trap in the renderer (MC-2109). Every surface that claims
// modality — `role="dialog"` with `aria-modal="true"` — wraps its dialog element
// in this, so Tab and Shift+Tab cycle inside it forever instead of walking out
// into the page behind the scrim. A modal that a keyboard can leave without
// closing is a modal in name only, and one of the offenders was advertising
// `aria-modal="true"` while doing exactly that.
//
// Sentinels, not a document-level `focusin` guard. `Popover`, `ContextMenu`,
// `PointerPopover` and `Tooltip` all portal their surfaces to `<body>` — outside
// the dialog's subtree — so a guard that yanked focus back to the dialog would
// break every menu a dialog opens. A sentinel only ever fires on the Tab that
// would have left, which is the exact moment we want.
//
// The trapped region is the siblings BETWEEN the two sentinels, not the parent
// element. That distinction is load-bearing: a multi-screen dialog stacks its
// New-item capture (`BacklogCreateDialog`) as a SIBLING of its dialog, and that
// capture is a `Modal` with a trap of its own. Reading the parent would fold the
// two dialogs into one cycle; reading the sibling span keeps them separate and
// lets the inner trap win while it is open, because its sentinels sit closer to
// the focused control.
import React, { useCallback, useRef } from 'react'

// Tabbable candidates, as close to the browser's own tab order as a selector
// gets: disabled controls and `tabindex="-1"` are out by construction.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const SENTINEL_ATTR = 'data-focus-sentinel'

type VisibilityCheckable = {
  checkVisibility?: (options?: { opacityProperty?: boolean; visibilityProperty?: boolean }) => boolean
}

// A control the browser would skip is a control the cycle must skip too — the
// such a dialog keeps screen 1 mounted under `hidden` while screen 2 shows,
// and tabbing into a display:none form is the bug this filter exists for.
// Chromium answers `checkVisibility` exactly; jsdom has no layout engine and no
// such method, so under test the selector alone decides.
function rendered(element: HTMLElement): boolean {
  const check = (element as HTMLElement & VisibilityCheckable).checkVisibility
  if (typeof check !== 'function') return true
  return check.call(element, { visibilityProperty: true })
}

function asFocusable(node: Element | null): HTMLElement | null {
  const element = node as HTMLElement | null
  return element && typeof element.focus === 'function' ? element : null
}

export function FocusTrap({ children }: { children: React.ReactNode }): JSX.Element {
  const startRef = useRef<HTMLSpanElement>(null)
  const endRef = useRef<HTMLSpanElement>(null)

  const tabbables = useCallback((): HTMLElement[] => {
    const start = startRef.current
    const end = endRef.current
    if (!start || !end) return []
    const found: HTMLElement[] = []
    for (let node = start.nextElementSibling; node && node !== end; node = node.nextElementSibling) {
      const element = asFocusable(node)
      if (!element) continue
      if (element.matches(FOCUSABLE_SELECTOR)) found.push(element)
      found.push(...Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)))
    }
    return found.filter((element) => !element.hasAttribute(SENTINEL_ATTR) && rendered(element))
  }, [])

  const wrap = useCallback(
    (edge: 'start' | 'end') => () => {
      const ring = tabbables()
      if (ring.length > 0) {
        const target = edge === 'start' ? ring[ring.length - 1] : ring[0]
        target.focus()
        return
      }
      // Nothing tabbable inside yet (a dialog still loading its body). Focus
      // falls back to the dialog shell itself — every trapped shell carries
      // `tabIndex={-1}` for exactly this — rather than leaking to the page.
      asFocusable(startRef.current?.nextElementSibling ?? null)?.focus()
    },
    [tabbables],
  )

  return (
    <>
      <span ref={startRef} data-focus-sentinel="true" tabIndex={0} className="sr-only" onFocus={wrap('start')} />
      {children}
      <span ref={endRef} data-focus-sentinel="true" tabIndex={0} className="sr-only" onFocus={wrap('end')} />
    </>
  )
}
