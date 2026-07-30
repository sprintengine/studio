import type { RefObject } from 'react'
import { TruncatedText } from '../../../ui'
import { screenSwitcherMode, type CanvasStudioNav } from './canvasStudioModel'

// The one floating pill that chromes the canvas (MC-1510): the screen/document
// switcher. Viewport/zoom/reload stay in the artifact frame's own header
// (existing HtmlArtifactFrame chrome) rather than being duplicated here, and
// so does the live Comment (annotate) toggle — T11 wired the sinks, so the
// pill's earlier disabled Comment placeholder is gone (never two toggles for
// one mode).

type Props = {
  nav: CanvasStudioNav
  /** Screens-drawer (7+ screens) toggle state, owned by the shell. */
  drawerOpen: boolean
  onToggleDrawer: () => void
  screensButtonRef: RefObject<HTMLButtonElement>
}

export function StudioToolbar({ nav, drawerOpen, onToggleDrawer, screensButtonRef }: Props) {
  // With no trailing controls, a nav-less pill would be an empty capsule.
  if (nav.kind === 'none') return null
  return (
    <div
      role="group"
      aria-label="Canvas controls"
      className="absolute left-1/2 top-3.5 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3.5 py-1.5 shadow-[var(--shadow-drawer)]"
    >
      <NavRegion
        nav={nav}
        drawerOpen={drawerOpen}
        onToggleDrawer={onToggleDrawer}
        screensButtonRef={screensButtonRef}
      />
    </div>
  )
}

function NavRegion({ nav, drawerOpen, onToggleDrawer, screensButtonRef }: Props) {
  if (nav.kind === 'screens') {
    const active = nav.screens.find((screen) => screen.id === nav.activeId)
    if (screenSwitcherMode(nav.screens.length) === 'drawer') {
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            ref={screensButtonRef}
            type="button"
            onClick={onToggleDrawer}
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-micro font-medium transition-colors focus-visible:focus-ring ${
              drawerOpen
                ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
                : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            Screens · <span className="tabular-nums">{nav.screens.length}</span>
          </button>
          <TruncatedText
            as="span"
            text={active?.name ?? 'No screen selected'}
            className="min-w-0 text-meta font-semibold text-[color:var(--text-strong)]"
          />
        </div>
      )
    }
    return (
      <PillSegmented
        ariaLabel="Screens"
        options={nav.screens.map((screen) => ({ id: screen.id, label: screen.name }))}
        activeId={nav.activeId}
        onSelect={nav.onSelect}
      />
    )
  }

  if (nav.kind === 'documents') {
    return (
      <PillSegmented
        ariaLabel="Stage documents"
        options={nav.documents}
        activeId={nav.activeId}
        onSelect={nav.onSelect}
      />
    )
  }

  if (nav.kind === 'gallery') {
    // design-system Gallery/File toggle (MC-1509): the live component gallery
    // grid, or the single-file preview of the selected bundle file.
    return (
      <PillSegmented
        ariaLabel="View"
        options={[
          { id: 'gallery', label: 'Gallery' },
          { id: 'file', label: 'File' },
        ]}
        activeId={nav.mode}
        onSelect={(id) => nav.onSelectMode(id === 'file' ? 'file' : 'gallery')}
      />
    )
  }

  return null
}

function PillSegmented({
  ariaLabel,
  options,
  activeId,
  onSelect,
}: {
  ariaLabel: string
  options: Array<{ id: string; label: string }>
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex min-w-0 overflow-hidden rounded-full border border-[color:var(--border-default)]"
    >
      {options.map((option, index) => {
        const isActive = option.id === activeId
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(option.id)}
            className={`
              max-w-[13ch] truncate px-2.5 py-1 text-micro transition-colors
              disabled:cursor-not-allowed
              focus-visible:focus-ring-inset
              ${index > 0 ? 'border-l border-[color:var(--border-subtle)]' : ''}
              ${
                isActive
                  ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-muted)] enabled:hover:bg-[color:var(--bg-hover)]'
              }
            `}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

