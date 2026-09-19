import { useCallback } from 'react'
import DiagnosticsContent from './DiagnosticsContent'
import { GhostButton } from '../ui'
import { Modal } from '../ui/Modal'

type Props = {
  onClose: () => void
}

// In-app modal shell around DiagnosticsContent: `Modal` supplies the scrim,
// the geometry, Escape, click-outside, the focus trap and focus restore, and
// this file supplies what is actually diagnostics-specific — a Pop-out action
// that reopens the same panel as a standalone window (so it can live on a
// second monitor while you work). The data/tables live in DiagnosticsContent,
// shared with that window.
//
// It used to be a hand-built shell: its own scrim, its own Escape listener, its
// own focus/restore effect, and its own `rounded-xl` / `border-strong` /
// `max-w-[1100px]` geometry — a fifth answer to a question the kit already
// answers.
export default function DiagnosticsOverlay({ onClose }: Props) {
  const handlePopOut = useCallback(() => {
    // Guard + surface failures instead of swallowing them: if the running app
    // predates the diagnostics main/preload changes, this IPC won't exist yet
    // and a silent no-op looks like a bug. A full app restart (not just a
    // renderer reload) registers the handler and rebinds preload.
    if (typeof window.api.diagnosticsOpenWindow !== 'function') {
      console.error(
        '[Diagnostics] diagnosticsOpenWindow is unavailable — restart the app (quit + `npm run dev`) to load the updated main process and preload.',
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
    <Modal open onClose={onClose} label="Performance diagnostics" size="workbench" layout="panel">
      <DiagnosticsContent
        headerActions={
          <>
            <GhostButton
              size="xs"
              onClick={handlePopOut}
              className="font-mono"
              aria-label="Open diagnostics in a separate window"
            >
              Pop out ⧉
            </GhostButton>
            <GhostButton size="xs" onClick={onClose} className="font-mono" aria-label="Close diagnostics">
              Close
            </GhostButton>
          </>
        }
      />
    </Modal>
  )
}
