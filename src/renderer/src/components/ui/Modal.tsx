// Z-index ladder for the renderer. ONE ladder of record, and it is the design
// system's — `--sem-z-*`, aliased into the app as `--z-*` in assets/index.css
// (MC-2119). This comment used to declare a second one, and the two disagreed
// about the top of the stack:
//
//   in-flow depth       z-10 in-canvas HUD / in-card raise, z-20 docked panes,
//                       z-30 panel-internal popovers, z-[35] canvas overlays
//                       — app utilities; these describe depth within a pane,
//                       not overlay layers, and stay as they are.
//   overlay layers      --z-drawer 40, --z-popover 50, --z-menu 60,
//                       --z-modal 70, --z-toast 80.
//
// The kit already sat on the token values everywhere except here: Drawer 40,
// Popover and Tooltip 50, ContextMenu and PointerPopover 60. Modal alone used
// 50 while claiming to be "always above everything else" — which put it a tier
// BELOW the menus, so a context menu opened over a dialog painted on top of it.
// Consuming the token both fixes that and removes the second ladder.
import React, { useEffect, useRef } from 'react'
import { CloseIconButton } from './Buttons'
import { FocusTrap } from './FocusTrap'
import { TruncatedText } from './TruncatedText'
import { OVERLAY_SHELL_CLASS, overlayWidthStyle, type OverlayWidth } from './tokens'

type ModalProps = {
  open: boolean
  onClose: () => void
  /**
   * What Escape means, when it does not mean close. Defaults to `onClose` —
   * which is the whole story for a one-screen dialog. A dialog with a second
   * SCREEN inside it (the New sprint dialog's roster editor) wants Escape to
   * step back before it closes, and it cannot express that by intercepting the
   * key first: this listener is registered by a child effect and therefore runs
   * before the host's own.
   */
  onEscape?: () => void
  labelledBy?: string
  /** Accessible name, for a dialog whose title is not a labelable element. */
  label?: string
  /**
   * A step on the width scale (`OVERLAY_WIDTH_PX`), never a pixel count. There
   * is no `width` escape hatch on purpose: the scale is the whole point of
   * MC-2110, and one caller with a private measure re-opens it.
   */
  size?: OverlayWidth
  /**
   * `scroll` — the shell scrolls as one piece under a viewport cap. The default,
   * and what a form or a question wants: header, body and footer move together,
   * which is why neither is separated by a rule.
   *
   * `panel` — a fixed-height flex column that clips its own overflow, for a
   * workbench whose interior panes scroll independently. One height for all of
   * them, so two workbenches opened in a row are the same box.
   */
  layout?: 'scroll' | 'panel'
  children: React.ReactNode
  contained?: boolean
}

// The one workbench height. Was 720px fixed (New sprint), 90vh (Diagnostics)
// and content-fit under 80vh (Rosters) — three answers to one question.
const PANEL_LAYOUT_CLASS = 'flex h-[min(760px,85vh)] flex-col overflow-hidden'
const SCROLL_LAYOUT_CLASS = 'max-h-[92vh] overflow-y-auto'

export function Modal({
  open,
  onClose,
  onEscape,
  labelledBy,
  label,
  size = 'standard',
  layout = 'scroll',
  children,
  contained = false,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handle = window.requestAnimationFrame(() => {
      const node = ref.current
      if (!node) return
      if (node.contains(document.activeElement)) return
      node.focus()
    })
    return () => {
      window.cancelAnimationFrame(handle)
      previous?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      // Escape closes the TOPMOST surface only. A popover or menu open inside
      // the dialog consumes the key first and marks it handled; without this
      // check the dialog closes out from under it, taking the surface the
      // person was actually dismissing with it. The roster manager carried
      // this guard privately before it became a Modal consumer (MC-2110).
      if (event.key === 'Escape' && !event.defaultPrevented) (onEscape ?? onClose)()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, onEscape])

  if (!open) return null

  return (
    <div
      // Scrim: `.overlay-scrim`, matching the Command Palette and every other
      // full-screen overlay so modals read as one system. That claim used to be
      // true of the scrim ONLY — the two shells inside it disagreed on width,
      // radius, border and shadow, and this one carried no shadow at all. Both
      // now draw `OVERLAY_SHELL_CLASS` and a step of the width scale, so the
      // comment describes the whole surface (MC-2110). No backdrop-filter — see
      // the class definition for the framerate cliff it causes.
      className={`overlay-scrim ${contained ? 'absolute' : 'fixed'} inset-0 z-[var(--z-modal)] flex items-center justify-center p-6`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {/* `aria-modal="true"` promises assistive tech that the page behind is
          unreachable. `FocusTrap` is what makes that true for the keyboard. */}
      <FocusTrap>
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-label={label}
          tabIndex={-1}
          style={overlayWidthStyle(size)}
          // Geometry from the scale, not from here: `OVERLAY_SHELL_CLASS` is the
          // same chrome the Command Palette and every migrated shell draw
          // (MC-2110). This primitive used to spell its own `rounded-[8px]` and
          // cast NO shadow at all, so the surface every dialog is supposed to
          // converge on was the shabbiest one in the product.
          className={`${OVERLAY_SHELL_CLASS} ${layout === 'panel' ? PANEL_LAYOUT_CLASS : SCROLL_LAYOUT_CLASS} outline-none`}
        >
          {children}
        </div>
      </FocusTrap>
    </div>
  )
}

type ModalHeaderProps = {
  title: string
  subtitle?: string
  titleId?: string
  onClose?: () => void
}

// Header, body, and footer are separated by space, not by rules. The modal
// shell already draws its own edge; a divider under the title and another above
// the buttons cuts a small dialog into three boxed strips for no structural
// gain. The shell scrolls as one piece, so neither rule was a scroll affordance
// either.
//
// The inset is 24px (`space.3xl`, the step the token's own metadata names as the
// modal inset), not the 20px this shipped with — the last of the four geometry
// drifts `design-system/components/modal/component.md` files under MC-2110.
export function ModalHeader({ title, subtitle, titleId, onClose }: ModalHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pb-0 pt-6">
      <div className="min-w-0">
        <TruncatedText
          as="h2"
          id={titleId}
          text={title}
          className="text-title font-semibold tracking-tight text-[color:var(--text-strong)]"
        />
        {subtitle ? (
          <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {onClose ? (
        <CloseIconButton size="md" aria-label="Close" onClick={onClose} />
      ) : null}
    </div>
  )
}

export function ModalBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-6 py-4 ${className ?? ''}`}>{children}</div>
}

export function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-6 pt-2">
      {children}
    </div>
  )
}

type FieldProps = {
  label: string
  hint?: string
  children: React.ReactNode
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-micro font-medium text-[color:var(--text-default)]">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-micro leading-4 text-[color:var(--text-disabled)]">{hint}</span> : null}
    </label>
  )
}

type ButtonVariant = 'primary' | 'ghost' | 'danger'

type ModalButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}

const PRIMARY_STYLES =
  'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)] hover:bg-[color:var(--accent-primary-hover)] disabled:hover:bg-[color:var(--accent-primary)]'

export function ModalButton({ variant = 'ghost', className, ...rest }: ModalButtonProps) {
  const base =
    // `text-heading`, not Tailwind's `text-sm` — the same 14px, but on the
    // ramp, so it moves if the ramp moves (MC-2119).
    'rounded-md px-3.5 py-2 text-heading font-semibold transition-colors focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-45'
  const styles: Record<ButtonVariant, string> = {
    primary: PRIMARY_STYLES,
    ghost:
      'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
    danger: 'bg-[color:var(--tone-error)] text-[color:var(--tone-error-ink)]',
  }
  return <button {...rest} className={`${base} ${styles[variant]} ${className ?? ''}`} />
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-micro font-medium text-[color:var(--text-default)]">
      {children}
    </div>
  )
}
