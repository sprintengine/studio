import { useCallback, useEffect, useRef } from 'react'
import DiagnosticsContent from './DiagnosticsContent'
import { FocusTrap } from '../ui/FocusTrap'

type Props = {
  onClose: () => void
}

// In-app modal shell around DiagnosticsContent: backdrop, Escape close, focus
// capture, and a Pop-out action that reopens the same panel as a standalone
// window (so it can live on a second monitor while you work). The data/tables
// live in DiagnosticsContent, shared with the standalone window.
export default function DiagnosticsOverlay({ onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // Initial focus and focus restore — the same open/close contract `Modal`
  // carries, so the overlay behaves like every other dialog (MC-2109). Kept
  // apart from the Escape effect and given no dependencies: a re-created
  // `onClose` must not re-run focus and yank the keyboard back to Close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // `mousedown`, matching `Modal`: dismissing on `click` fires when a drag that
  // STARTED inside the dialog (selecting a metric row) is released over the
  // scrim, which reads as the overlay closing itself.
  const handleBackdropMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) onClose()
    },
    [onClose]
  )

  const handlePopOut = useCallback(() => {
    // Guard + surface failures instead of swallowing them: if the running app
    // predates the diagnostics main/preload changes, this IPC won't exist yet
    // and a silent no-op looks like a bug. A full app restart (not just a
    // renderer reload) registers the handler and rebinds preload.
    if (typeof window.api.diagnosticsOpenWindow !== 'function') {
      console.error(
        '[Diagnostics] diagnosticsOpenWindow is unavailable — restart the app (quit + `npm run dev`) to load the updated main process and preload.'
      )
      return
    }
    window.api
      .diagnosticsOpenWindow()
      .then(() => onClose())
      .catch((error) => {
        console.error('[Diagnostics] Failed to open the diagnostics window:', error)
      })
  }, [onClose])

  return (
    <div
      // Diagnostics is a modal dialog, so it takes the modal layer by name —
      // through the app's `--z-*` alias, like every other overlay. It used to
      // read `--sem-z-modal` straight from the bundle, which put its stacking on
      // a different scale from the surfaces it has to sit above (MC-2109).
      className="overlay-scrim fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6"
      onMouseDown={handleBackdropMouseDown}
    >
      <FocusTrap>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Performance diagnostics"
          tabIndex={-1}
          className="flex h-full max-h-[90vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-modal)] outline-none"
        >
          <DiagnosticsContent
            headerActions={
              <>
                <button
                  onClick={handlePopOut}
                  className="rounded px-2 py-1 font-mono text-meta text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
                  aria-label="Open diagnostics in a separate window"
                >
                  Pop out ⧉
                </button>
                <button
                  ref={closeButtonRef}
                  onClick={onClose}
                  className="rounded px-2 py-1 font-mono text-meta text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
                  aria-label="Close diagnostics"
                >
                  Close
                </button>
              </>
            }
          />
        </div>
      </FocusTrap>
    </div>
  )
}
