import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Badge } from './Badge'
import { Tooltip } from './Tooltip'
import { FOCUS_RING_CLASS, FOCUS_RING_INSET_CLASS } from './tokens'

export type TabItem<T extends string = string> = {
  id: T
  label: string
  /** Optional canonical count rendered next to the label. */
  count?: number | string
  /** Optional leading icon. Pass a node (e.g. <InboxIcon />) or a render
   *  function that receives a className. */
  icon?: React.ReactNode | ((props: { className?: string }) => React.ReactNode)
  disabled?: boolean
  /** Accessible name of the tab's close affordance ("Close Files"). Rendered
   *  only when the strip also has `onCloseItem`; a tab without one cannot be
   *  closed from the strip. */
  closeLabel?: string
  /** Hover/focus text on an `iconOnly` strip; defaults to `label`. This is
   *  where a count the glyph cannot show belongs ("Log \u00b7 3,057 commits"):
   *  an icon-only tab draws no `count`, so anything the number has to say has
   *  to be said here. */
  tooltip?: string
  /** The tab's accessible name, when the words on it are not the whole of what
   *  it says. A labelled tab that also draws a state glyph is the case: the
   *  glyph is `aria-hidden`, so without this the state exists for the eye and
   *  for nobody else ("anthropics/skills — update available"). */
  ariaLabel?: string
  /**
   * News waiting INSIDE this tab, as the kit's corner counter docked on the
   * tab's top-right — the same unread pip the app rail's squares and the
   * Extensions drawer's rows wear, so "there is something here" is one drawing
   * wherever the product says it (owner, 2026-09-10).
   *
   * It is not `count`. `count` is how many things this tab holds and rides
   * beside the label in the reading line; this is how many of them want the
   * person, and it sits above the words because it is not part of them.
   * Undefined or 0 draws nothing: a badge reading "0" is a badge spent saying
   * there is no news.
   */
  badgeCount?: number
  /** What the corner count is, with the tab in it ("Plugins: 3 updates"). A
   *  bare number docked on a word is not a sentence, so the badge is always
   *  named — never `decorative`, because nothing else on the tab says this. */
  badgeLabel?: string
}

type TabsProps<T extends string = string> = {
  /** Required accessible name for the tablist. */
  ariaLabel: string
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  /** Stable id prefix; auto-generated when not supplied. */
  idPrefix?: string
  className?: string
  /** Omit the built-in bottom hairline so a parent container can own the row
   *  border (needed when the tab row hosts trailing inline controls). */
  borderless?: boolean
  /** Closable strips (the workspace pane): a close glyph revealed on hover and
   *  focus sits in each closable tab's trailing padding. It is a sibling of the
   *  tab button, not a child — a button inside a button is invalid — and stays
   *  out of the tab order, so the strip remains one tab stop; keyboard closing
   *  is the host's shortcut. */
  onCloseItem?: (id: T) => void
  /** Middle-click and the like on a tab. */
  onItemAuxClick?: (id: T, event: React.MouseEvent<HTMLButtonElement>) => void
  onItemContextMenu?: (id: T, event: React.MouseEvent<HTMLButtonElement>) => void
  /** Glyph-only strip: each tab renders its `icon` alone, `label` becomes the
   *  accessible name, and `tooltip ?? label` shows on hover and focus. For a
   *  strip whose choices have settled glyphs and whose band cannot spend the
   *  width on words — the Git view strip riding the panel's own chrome row.
   *  Every item MUST carry an `icon`; a labelless tab with no glyph is a blank
   *  button. */
  iconOnly?: boolean
}

export function Tabs<T extends string = string>({
  ariaLabel,
  items,
  value,
  onChange,
  idPrefix,
  className,
  borderless,
  onCloseItem,
  onItemAuxClick,
  onItemContextMenu,
  iconOnly = false,
}: TabsProps<T>) {
  const fallbackPrefix = useId()
  const prefix = idPrefix ?? fallbackPrefix
  const listRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const focusTabAt = useCallback((index: number) => {
    if (!listRef.current) return
    const tabs = Array.from(listRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'))
    if (tabs.length === 0) return
    const wrapped = (index + tabs.length) % tabs.length
    tabs[wrapped]?.focus()
  }, [])

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (!target || target.getAttribute('role') !== 'tab') return
      const enabled = items.filter((item) => !item.disabled)
      const currentIndex = enabled.findIndex((item) => item.id === target.dataset.tabId)
      if (currentIndex === -1) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const next = enabled[(currentIndex + 1) % enabled.length]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        const next = enabled[(currentIndex - 1 + enabled.length) % enabled.length]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      } else if (event.key === 'Home') {
        event.preventDefault()
        const next = enabled[0]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      } else if (event.key === 'End') {
        event.preventDefault()
        const next = enabled[enabled.length - 1]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      }
    },
    [items, onChange, focusTabAt],
  )

  useEffect(() => {
    // Keep at most one tab in the tab order at any time; the active tab is the
    // one that participates in roving focus.
    if (!listRef.current) return
    const tabs = listRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs.forEach((tab) => {
      tab.tabIndex = tab.dataset.tabId === valueRef.current ? 0 : -1
    })
  }, [value, items])

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={[
        'flex items-center gap-0.5',
        borderless ? '' : 'border-b border-[color:var(--border-default)]',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {items.map((item) => {
        const selected = item.id === value
        const tabId = `${prefix}-tab-${item.id}`
        const panelId = `${prefix}-panel-${item.id}`
        // 16px on an icon-only strip (the toolbar step), 13px beside a label
        // (the inline step) — the ramp's two answers to "is this glyph the
        // control, or a mark next to the word that is".
        const iconClass = iconOnly ? 'size-icon-sm shrink-0' : 'size-icon-xs shrink-0'
        const iconNode = typeof item.icon === 'function' ? item.icon({ className: iconClass }) : item.icon
        const closable = Boolean(onCloseItem && item.closeLabel)
        // An icon-only strip draws no badge: its tab is a 30px square with no
        // room to dock one clear of the glyph, and the tooltip is where that
        // strip already puts what the glyph cannot show. A closable tab draws
        // none either — its trailing padding is already spoken for by the close
        // glyph, and two things docked in one corner is neither of them.
        const badged = !iconOnly && !closable && typeof item.badgeCount === 'number' && item.badgeCount > 0
        const tab = (
          <button
            key={closable ? undefined : item.id}
            id={tabId}
            role="tab"
            type="button"
            data-tab-id={item.id}
            aria-selected={selected}
            aria-controls={panelId}
            // The glyph carries no words, so the name comes from the label the
            // tooltip is also showing — one name, two renderings. A labelled tab
            // names itself, unless it draws something the label does not say.
            //
            // A badged tab is one of those. The counter is a named live region
            // (it has to be — the number moves while the reader is elsewhere),
            // and a named child inside a button lands in the button's own
            // name-from-contents: the tab announced as "Studio: 3 updates
            // available Studio 10". An explicit name wins over name-from-
            // contents, so the tab says its piece once and the counter keeps
            // announcing changes on its own.
            aria-label={
              item.ariaLabel ??
              (badged
                ? (item.badgeLabel ?? `${item.label}: ${item.badgeCount} waiting`)
                : iconOnly
                  ? item.label
                  : undefined)
            }
            disabled={item.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!item.disabled) onChange(item.id)
            }}
            onAuxClick={onItemAuxClick ? (event) => onItemAuxClick(item.id, event) : undefined}
            onContextMenu={onItemContextMenu ? (event) => onItemContextMenu(item.id, event) : undefined}
            className={[
              // `shrink-0 whitespace-nowrap`: a tab row in a narrow panel scrolls
              // inside its own overflow container rather than compressing its
              // labels — a flex child otherwise shrinks to fit its parent.
              'relative inline-flex h-control-sm shrink-0 items-center gap-1.5 whitespace-nowrap text-meta',
              // The 1px overlap that draws the active underline ON the row's
              // hairline — but ONLY when this row draws that hairline. A
              // borderless strip's line belongs to a parent BAND, and the tab
              // hanging a pixel past its own box is a pixel the band's overflow
              // container clips: it clipped exactly the underline, which is why
              // a scrolling borderless strip had no visible selection at all.
              borderless ? '' : '-mb-px',
              // Icon-only tabs sit on a square-ish footprint: the label's
              // inline padding around a 16px glyph reads as a gap, not a tab.
              //
              // The inline padding is emitted per SIDE whenever a trailing
              // reservation follows. `px-3` next to `pr-8` is two utilities
              // setting the same edge, and which one wins is decided by
              // stylesheet order, not by this list. The app's own sheet sorts
              // `pr-8` last, but a module's stylesheet is injected after it and
              // re-declares the utilities that module uses in the same layer —
              // with `px-3` among them the shorthand won, the reserved 32px
              // collapsed to 12, and the close glyph was drawn on top of the
              // last letters of the label. Two utilities that never share an
              // edge cannot be reordered into a bug.
              iconOnly ? 'w-control-sm justify-center px-0' : closable || badged ? 'pl-3' : 'px-3',
              'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              // The close glyph sits in this reserved trailing padding, so
              // revealing it never reflows the label. A closable tab is a
              // document tab (a page title, a file), so it also caps its
              // width and truncates rather than letting one title own the row.
              closable ? 'max-w-[220px] pr-8' : '',
              // The corner count sits in reserved trailing padding rather than
              // overhanging the tab's box: this strip scrolls inside an
              // `overflow-x` container, which clips anything hanging past the
              // edge — the same clip that once ate the active underline.
              badged ? 'pr-6' : '',
              selected
                ? 'text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
          >
            {badged ? (
              // Docked by this strip rather than by the badge's own `corner`
              // mode: `corner` hangs the counter 4px outside its trigger, and
              // outside this trigger is the scroll container's clip. It sits in
              // the trailing padding reserved above instead — the same top-right
              // corner, drawn where it survives. No keyline either: `corner`'s
              // ring exists to lift the badge off the glyph it covers, and this
              // one covers nothing but the band.
              <span className="absolute right-1 top-0.5 inline-flex">
                <Badge
                  tone="accent"
                  count={item.badgeCount as number}
                  max={99}
                  ariaLabel={item.badgeLabel ?? `${item.label}: ${item.badgeCount} waiting`}
                />
              </span>
            ) : null}
            {iconNode ? (
              <span aria-hidden="true" className="inline-flex">
                {iconNode}
              </span>
            ) : null}
            {iconOnly ? null : (
              <>
                <span className={closable ? 'min-w-0 truncate' : undefined}>{item.label}</span>
                {item.count !== undefined ? (
                  <span className="tabular-nums text-micro text-[color:var(--text-muted)]">{item.count}</span>
                ) : null}
              </>
            )}
            <span
              aria-hidden="true"
              className={[
                'absolute bottom-0 left-2 right-2 h-px',
                selected ? 'bg-[color:var(--accent-primary)]' : 'bg-transparent',
              ].join(' ')}
            />
          </button>
        )
        if (iconOnly) {
          return (
            <Tooltip key={item.id} content={item.tooltip ?? item.label} placement="bottom">
              {tab}
            </Tooltip>
          )
        }
        if (!closable) return tab
        return (
          <span key={item.id} className="group/tab relative inline-flex shrink-0">
            {tab}
            <button
              type="button"
              tabIndex={-1}
              aria-label={item.closeLabel}
              onClick={(event) => {
                event.stopPropagation()
                onCloseItem?.(item.id)
              }}
              className={[
                'absolute right-2 top-1/2 inline-flex size-icon-sm -translate-y-1/2 items-center justify-center rounded-sm',
                'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                selected ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100',
                FOCUS_RING_CLASS,
              ].join(' ')}
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        )
      })}
    </div>
  )
}

// How far the fade at an overflowing edge reaches. One value, both edges.
const STRIP_FADE = '28px'

type TabsScrollerProps = {
  children: React.ReactNode
  /** Classes on the scroll container itself (sizing, alignment). */
  className?: string
}

/**
 * The overflow container a tab strip lives in when it can outgrow its band.
 *
 * Three rules, and each is a thing the plain `overflow-x-auto` it replaces got
 * wrong on a 36px strip:
 *
 * - **No scrollbar, ever.** A 10px bar under the tabs is a second horizontal
 *   line in a band that already has one, and it eats a third of the row.
 * - **The overflow says so itself.** Each edge with content past it fades to
 *   transparent, so a clipped tab reads as "there is more this way" rather than
 *   as a tab that has been cut in half.
 * - **A plain vertical wheel scrolls it.** A horizontal row has no vertical
 *   axis to spend the gesture on, and the wheel over a strip of tabs is the
 *   gesture people actually make. Wired natively (not via React's passive
 *   `onWheel`) so the gesture can be claimed instead of also scrolling an
 *   ancestor.
 */
export function TabsScroller({ children, className }: TabsScrollerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // 1px slack: fractional layout widths leave a sub-pixel of "overflow" on a
    // strip that fits, which would paint a fade over nothing.
    const max = el.scrollWidth - el.clientWidth
    const next = { start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 }
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [])

  // Layout effect: the fade is part of the first paint, not a correction to it.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    if (typeof ResizeObserver !== 'function') return
    // The container AND its content: a tab opening or closing changes the
    // scroll width without changing the box the observer was watching.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [measure, children])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      // A trackpad's horizontal component is already the browser's to handle.
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return
      event.preventDefault()
      el.scrollLeft += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Masked, not overlaid: a gradient block painted on top would have to know
  // the band's background colour, and the strip sits on three different ones.
  // The stops are a mask's ALPHA channel — "opaque here, transparent there" —
  // so they are the one thing in this file that cannot come from a colour
  // token: any ink would do, and naming one would imply the fade has a hue.
  // design-tokens-allow: mask alpha channel, not ink — a colour token cannot express "opaque"
  const OPAQUE = '#000'
  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, transparent 0, ${OPAQUE} ${edges.start ? STRIP_FADE : '0px'}, ${OPAQUE} calc(100% - ${edges.end ? STRIP_FADE : '0px'}), transparent 100%)`
      : undefined

  return (
    <div
      ref={ref}
      onScroll={measure}
      className={['strip-scroll overflow-x-auto overflow-y-hidden', className ?? ''].filter(Boolean).join(' ')}
      // design-tokens-allow: the two stops are a mask's alpha channel (opaque /
      // transparent), not ink — no palette token can express them.
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </div>
  )
}

type TabPanelProps = {
  /** Stable id prefix matching the parent Tabs. */
  idPrefix: string
  tabId: string
  active: boolean
  children: React.ReactNode
  className?: string
}

export function TabPanel({ idPrefix, tabId, active, children, className }: TabPanelProps) {
  if (!active) return null
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tabId}`}
      aria-labelledby={`${idPrefix}-tab-${tabId}`}
      // The panel is a focusable scroll container, so it is a tab stop and needs
      // a signal that the keyboard is driving the region. Without this it falls
      // back to Chromium's UA outline — the one treatment the design system
      // cannot theme. Inset, as the door listboxes already do, because the
      // indicator sits at the edge of a scrolling region.
      className={[className ?? '', FOCUS_RING_INSET_CLASS].filter(Boolean).join(' ')}
      tabIndex={0}
    >
      {children}
    </div>
  )
}
