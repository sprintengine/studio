import React, { useContext, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { CloseIconButton, IconButton } from '../../ui'
import { SIDEBAR_DEFAULT_WIDTH } from '../sidebarWidth'
import { useContextRailSlot } from './contextRail'
import { useGlobalSurfaceBarSlot } from './surfaceBarSlot'

// A host that mounts a global surface as a full-page "door" lifts the surface bar
// out of the surface body and into the app's top strip, collapsing what would
// otherwise be two stacked bars (the empty workspace strip + the surface's own
// bar) into one. The host supplies the destination element (surfaceBarSlot.ts);
// the shell portals its bar there instead of rendering it inline. A surface with
// no host in scope (tests, storybook) falls back to the inline bar unchanged.
export { GlobalSurfaceBarSlotContext } from './surfaceBarSlot'

// The shared frame for door-routed full-page surfaces (global-surfaces epic
// 1704, mockup §1/§2 anatomy): a surface bar (title · status chip · context sub
// · actions), an optional attention strip, and a body of an optional internal
// list rail beside a full-width canvas. It owns only layout, the token surface,
// and the region landmark — every surface (Roadmap here, Automations and Reviews
// in their own tasks) supplies its own bar content, rail, and canvas. The rail
// belongs to the surface, never the app sidebar.
//
// Slots are optional so a surface can adopt the anatomy incrementally: the
// Roadmap tenant (T1) renders canvas-only while its board keeps its own header,
// and the roadmap-page rebuild (T2) plus the Automations/Reviews pages lift their
// bar and rail into these slots. This is not a modal — it fills the card region
// as a page — so it carries no scrim and no focus trap.
//
// Both chrome slots LIFT into the app shell when the host offers a destination:
// the bar into the top strip, and (item 1993) the rail into the app sidebar's own
// column, replacing the workspaces rail for as long as the surface is open. A
// surface writes its bar and rail once and does not know which host it got.

// The bar is the door's NAME and its controls — nothing else. It rides the app's
// one top strip, beside the window's own controls, so everything put here is
// taken from the width the strip has for real work. A status chip ("Draft",
// "In progress", "2 ready to launch") and a counts line ("318 in marketplace ·
// 1 installed") both restate what the page under them already shows, which is
// why neither has a slot any more: state belongs to the thing that has the
// state, not to the title of the room it is in.
export type GlobalSurfaceBar = {
  /** The surface name. Rendered as the page-region heading. */
  title: React.ReactNode
  /** Trailing controls, right-aligned; optional. */
  actions?: React.ReactNode
}

// Chrome signal from the modal host (doors→modals, 2026-09-01; owner ruling
// same day: one close mechanism for every modal). When a surface mounts inside
// the shell's Modal, its bar suppresses the door-era back chevron and instead
// renders an X at the top right, wired to the host's close — the same gesture
// on Settings, Plugins, Automations and Design. The bar's title is the host's
// `label` — the surface's NAME ("Automations"), never the contextual title the
// surface's own bar carries (the selected automation's name), so every modal
// names the room, not the thing currently in it. Null in a door host (and in
// tests), where the chevron stays the door's one exit and the surface titles
// its own bar.
export const ModalSurfaceChromeContext = React.createContext<{
  close: () => void
  label: string
  /**
   * The shell reports whether the BODY rendered the modal bar, mirroring
   * onRailPresence: while nothing claims it (a Suspense fallback, a
   * third-party body that never uses the shell) the host frame renders the
   * same bar itself, so every modal has its name and its X in every state.
   */
  onBarPresence: (present: boolean) => void
} | null>(null)

// The one modal title bar (owner, 2026-09-01): a step taller than the door bar
// and at the title type step — a dialog names itself more loudly than a page
// whose name rides the app strip — with the X as the one close. Rendered by
// the shell when the body supplies a bar (its actions join the trailing
// cluster), and by ModalSurfaceFrame as the fallback otherwise.
function ModalSurfaceBar({
  title,
  actions,
  onClose,
}: {
  title: string
  actions?: React.ReactNode
  onClose: () => void
}): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-5 py-3">
      <h2 className="truncate text-title font-semibold tracking-tight text-[color:var(--text-strong)]">
        {title}
      </h2>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {actions}
        <CloseIconButton size="md" aria-label="Close" onClick={onClose} />
      </div>
    </div>
  )
}

/**
 * The modal host's wrapper around a modal-surface body: provides the chrome
 * context (X close, host label) and renders the fallback modal bar while no
 * body bar has claimed it — so a lazy body loading in Suspense, and a
 * third-party body that never renders GlobalSurfaceShell, both still get a
 * titled bar with the one close affordance instead of a chromeless dialog
 * whose only exits are Escape and the scrim.
 */
export function ModalSurfaceFrame({
  label,
  close,
  children,
}: {
  label: string
  close: () => void
  children: React.ReactNode
}): JSX.Element {
  const [barClaimed, setBarClaimed] = React.useState(false)
  const chrome = React.useMemo(
    () => ({ close, label, onBarPresence: setBarClaimed }),
    [close, label],
  )
  return (
    <ModalSurfaceChromeContext.Provider value={chrome}>
      <div className="flex h-full min-h-0 flex-col">
        {barClaimed ? null : <ModalSurfaceBar title={label} onClose={close} />}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </ModalSurfaceChromeContext.Provider>
  )
}

export type GlobalSurfaceShellProps = {
  /** Accessible name for the surface region landmark, e.g. "Roadmap". */
  ariaLabel: string
  /** The surface bar. Omit for a canvas-only surface that self-chromes. */
  bar?: GlobalSurfaceBar
  /** Attention strip below the bar (the "waiting on you" band); optional. */
  attention?: React.ReactNode
  /** Internal list rail left of the canvas; optional. */
  rail?: React.ReactNode
  /**
   * Back affordance for the surface bar (mockup #view-doors). When `canGoBack`
   * is true the bar shows a leading chevron that invokes `onBack` — leaving the
   * door. Omit for a surface with nowhere to go back to; surfaces derive both
   * from `useSurfaceBackNav`.
   *
   * Rendered by BOTH hosts, inline and lifted. It used to be suppressed whenever
   * the host took the surface's rail, on the grounds that the rail's pinned
   * `Back` row (item 1993) was the one way out — but every door in the product
   * hands over a rail, so the suppression was total: the chevron never rendered
   * and the only exit sat at the bottom-left of a scrolling column, the last
   * place the eye goes and the furthest point from the title of the thing it
   * leaves. The chevron is back, glued to the door's name, and the rail row is
   * gone with it. Still ONE affordance, just the one that reads.
   */
  onBack?: () => void
  canGoBack?: boolean
  /** The full-width canvas. */
  children: React.ReactNode
}

export function GlobalSurfaceShell({
  ariaLabel,
  bar,
  attention,
  rail,
  onBack,
  canGoBack,
  children,
}: GlobalSurfaceShellProps): JSX.Element {
  // When a lift target is provided the bar rides the app's top strip instead of a
  // second row here; `liftBar` stays true even while `el` is momentarily null so
  // the inline bar never flashes in during the settle.
  const barSlot = useGlobalSurfaceBarSlot()
  const liftBar = barSlot !== null
  // Item 1993: a host that replaces its rail takes this surface's rail into the
  // app sidebar's own column. Same settle rule as the bar, and the same reason:
  // the inline aside must never flash in. The rail no longer owns `Back` — that
  // is the bar chevron's job on either host.
  const railSlot = useContextRailSlot()
  const liftRail = railSlot !== null
  const hasRail = Boolean(rail)
  const onRailPresence = railSlot?.onRailPresence
  // Tell the host whether there is a rail to take. Every door DECLARES one in
  // every load state (T19), so this is true for the whole of a door's visit; a
  // surface that genuinely brings none replaces nothing (the host keeps its own
  // rail) and therefore keeps its bar chevron — otherwise it would be a page
  // with no way out at all.
  useEffect(() => {
    if (!onRailPresence) return undefined
    onRailPresence(hasRail)
    return () => onRailPresence(false)
  }, [onRailPresence, hasRail])
  const modalChrome = useContext(ModalSurfaceChromeContext)
  // In a modal host the X is the one exit; the chevron never renders beside it.
  const showBack = Boolean(canGoBack && onBack) && modalChrome === null
  // Claim the modal bar from the host frame while this shell renders one, so
  // the frame's fallback bar never doubles it (same settle contract as
  // onRailPresence above).
  const onBarPresence = modalChrome?.onBarPresence
  const rendersModalBar = Boolean(bar) && modalChrome !== null
  useEffect(() => {
    if (!onBarPresence) return undefined
    onBarPresence(rendersModalBar)
    return () => onBarPresence(false)
  }, [onBarPresence, rendersModalBar])
  // Keyboard focus follows the surface that just mounted, but only when the
  // click that opened it left focus nowhere. A tile on the Extensions home
  // unmounts with the page it is on, so its click dropped focus to `<body>` and
  // the next Tab restarted at the top of the window; a drawer row survives its
  // own click and keeps focus, which is why it never showed the same fault. The
  // region is a `tabIndex={-1}` landmark, so this is a programmatic focus that
  // never draws a ring and never steals focus from a control the person moved
  // to themselves.
  const regionRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body) return
    regionRef.current?.focus({ preventScroll: true })
  }, [ariaLabel])
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label={ariaLabel}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--bg-surface)] outline-none"
    >
      {bar && modalChrome ? (
        // Titled by the host's label (the surface's name), never bar.title:
        // Automations' own bar becomes the selected automation mid-visit, and
        // the dialog must keep saying "Automations". The surface's bar actions
        // join the trailing cluster beside the X.
        <ModalSurfaceBar title={modalChrome.label} actions={bar.actions} onClose={modalChrome.close} />
      ) : null}
      {bar && !liftBar && !modalChrome ? (
        <div className="flex h-[36px] shrink-0 items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3">
          {showBack && onBack ? <BarBackChevron onBack={onBack} /> : null}
          <h2 className="truncate text-body font-semibold text-[color:var(--text-strong)]">{bar.title}</h2>
          {bar.actions ? <div className="ml-auto flex items-center gap-1.5">{bar.actions}</div> : null}
        </div>
      ) : null}
      {bar && liftBar && barSlot.el
        ? createPortal(
            // Portaled through the React tree so `bar.actions` keep the surface's
            // own handlers/context. A leading back chevron appears when the door
            // has somewhere to go back to; the title truncates; the actions stay
            // pinned to the right edge of the slot.
            <>
              {showBack && onBack ? <BarBackChevron onBack={onBack} inGutter /> : null}
              <h2 className="truncate text-body font-semibold text-[color:var(--text-strong)]">
                {bar.title}
              </h2>
              {bar.actions ? (
                <div className="ml-auto flex shrink-0 items-center gap-1.5">{bar.actions}</div>
              ) : null}
            </>,
            barSlot.el,
          )
        : null}
      {attention ? (
        <div className="shrink-0 border-b border-[color:var(--border-subtle)]">{attention}</div>
      ) : null}
      {rail && liftRail && railSlot.el ? createPortal(rail, railSlot.el) : null}
      <div className="flex min-h-0 flex-1">
        {rail && !liftRail ? (
          <aside
            aria-label={`${ariaLabel} list`}
            // The sidebar's DEFAULT width, deliberately — not the person's
            // current one. When the host lifts a surface's rail into the app
            // sidebar (item 1993) the rail IS that column and wears whatever
            // width it was dragged to. This aside is the other case: a second
            // column, inside the card region, standing BESIDE the sidebar
            // rather than replacing it (`railPlacement: 'inline'`). Tying it to
            // the live `sidebarWidth` would make a door's own rail jump every
            // time the unrelated column next to it was dragged. So it takes the
            // scale's number from the same constant — which is still what
            // retired the second, unrelated `w-[224px]` that made a door two
            // rails wide. It scrolls and insets nothing: the rail owns both, so
            // its create/search head can sit outside the scrollport and paint no
            // ground of its own (see `SurfaceRailHeader`).
            // In a modal the rail yields before the canvas does: the shell is
            // capped at 95vw, so on a narrow window a fixed rail would eat the
            // canvas — 30vw keeps the sidebar-width rail on a full-size window
            // and shrinks it smoothly below ~930px. Rows truncate; the door
            // fallback keeps the app sidebar's fixed width.
            style={{ width: modalChrome ? `min(${SIDEBAR_DEFAULT_WIDTH}px, 30vw)` : SIDEBAR_DEFAULT_WIDTH }}
            // In a modal the rail sits on the darker app ground (owner,
            // 2026-09-01: the raised tone read as washed out, especially in
            // dark mode) — the same ground the app sidebar has, so the modal
            // reads as a small app. The door fallback keeps the raised tone.
            className={`flex min-h-0 shrink-0 flex-col border-r border-[color:var(--border-subtle)] ${
              // Owner ruled the MODAL rail darker (2026-09-01); the door
              // fallback keeps the raised ground the brand checklist mandates.
              modalChrome ? 'bg-[color:var(--bg-app)]' /* door-surfaces-allow: modal rail only, owner 2026-09-01 */ : 'bg-[color:var(--bg-surface-raised)]'
            }`}
          >
            {rail}
          </aside>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </section>
  )
}

// The bar-slot back chevron (mockup #view-doors): a compact ghost affordance that
// leaves the door. It is the door's ONE exit, and Escape is its keyboard twin.
//
// `inGutter` is optical alignment, not a nudge. The lifted bar slot indents by the
// 20px door gutter so the door's name shares a vertical line with the content
// under it (WorkspaceHeader). A chevron placed at that line would push the title
// off it and put a 24px button's worth of padding where 20px was measured, so the
// button hangs 8px back instead: its glyph — inset ~7px inside the box — lands on
// the gutter line, and the LEADING EDGE OF THE BAR keeps the alignment the title
// used to keep alone. The inline fallback bar has no gutter to align to, so it
// takes the plain box.
// The kit's `IconButton` (26px, the one icon-button size) rather than a hand
// 24px box: the chevron used to be the only icon control in the strip at its
// own size, radius and hover recipe.
function BarBackChevron({ onBack, inGutter = false }: { onBack: () => void; inGutter?: boolean }): JSX.Element {
  return (
    <IconButton
      onClick={onBack}
      aria-label="Back"
      className={`shrink-0 ${inGutter ? '-ml-2' : ''}`}
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-md" aria-hidden="true">
        <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </IconButton>
  )
}
