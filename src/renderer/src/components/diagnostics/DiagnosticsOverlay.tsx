import { useCallback, useEffect, useRef } from 'react'
import DiagnosticsContent from './DiagnosticsContent'

type Props = {
  onClose: () => void
}

// In-app modal shell around DiagnosticsContent: backdrop, Escape close, focus
// capture, and a Pop-out action that reopens the same panel as a standalone
// window (so it can live on a second monitor while you work). The data/tables
// live in DiagnosticsContent, shared with the standalone window.
export default function DiagnosticsOverlay({ onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    closeButtonRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleBackdropClick = useCallback(
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
      className="overlay-scrim fixed inset-0 z-[60] flex items-center justify-center p-6"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Performance diagnostics"
        className="flex h-full max-h-[90vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] shadow-2xl"
      >
        <DiagnosticsContent
          headerActions={
            <>
              <button
                onClick={handlePopOut}
                className="rounded px-2 py-1 font-mono text-[12px] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
                aria-label="Open diagnostics in a separate window"
              >
                Pop out ⧉
              </button>
              <button
                ref={closeButtonRef}
                onClick={onClose}
                className="rounded px-2 py-1 font-mono text-[12px] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
                aria-label="Close diagnostics"
              >
                Close
              </button>
            </>
          }
        />
      </div>
    </div>
  )
}
