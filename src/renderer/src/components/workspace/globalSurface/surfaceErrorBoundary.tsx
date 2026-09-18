// The door error boundary (MC-1835), on its own so the shell can hold it from
// boot. A door failure is contained to the door: without this, any throw in a
// surface's render — or a lazy chunk failing to load — propagated to the root
// and white-screened the whole renderer. The fallback follows the copy-voice
// error shape: state first, blast radius named, two recoveries — remount the
// surface, or close the door and keep working.
//
// It lives beside `surfaceSubstrate.tsx` rather than inside it because
// `WorkspaceManager` wraps every door in this boundary at first paint, and the
// substrate is a door's own furniture — the rail, its search input, its filter
// menu — which no boot render touches. The error card it draws is the
// substrate's `SurfaceCanvasState`, fetched only if a door actually crashes.

import React from 'react'

import { GhostButton } from '../../ui/Buttons'

const SurfaceCanvasState = React.lazy(() =>
  import('./surfaceSubstrate').then((m) => ({ default: m.SurfaceCanvasState })),
)

interface GlobalSurfaceErrorBoundaryProps {
  /** The door id ("design", "automations", …) — names the surface in the log line. */
  surfaceId: string
  /** Human name for the fallback title ("Reviews hit a problem and stopped"). */
  surfaceLabel: string
  onClose: () => void
  children: React.ReactNode
}

interface GlobalSurfaceErrorBoundaryState {
  failed: boolean
}

export class GlobalSurfaceErrorBoundary extends React.Component<
  GlobalSurfaceErrorBoundaryProps,
  GlobalSurfaceErrorBoundaryState
> {
  state: GlobalSurfaceErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): GlobalSurfaceErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[global-surface] the ${this.props.surfaceId} door crashed`, error)
  }

  componentDidUpdate(previous: GlobalSurfaceErrorBoundaryProps): void {
    // The boundary instance is reused as the operator moves between doors; a
    // failure in one surface must not stick to the next one.
    if (previous.surfaceId !== this.props.surfaceId && this.state.failed) {
      // oxlint-disable-next-line react/no-did-update-set-state -- guarded reset, runs once per switch
      this.setState({ failed: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        // The card is fetched at failure time. `fallback={null}` because the
        // door's own frame is already on screen and one blank frame beats a
        // spinner that announces a second wait after a crash.
        <React.Suspense fallback={null}>
          <SurfaceCanvasState
            kind="error"
            title={`${this.props.surfaceLabel} hit a problem and stopped.`}
            hint="The rest of the app is unaffected. Reload the surface, or close it and keep working."
            onRetry={() => this.setState({ failed: false })}
            retryLabel="Reload surface"
            extraAction={<GhostButton onClick={this.props.onClose}>Close</GhostButton>}
          />
        </React.Suspense>
      )
    }
    return this.props.children
  }
}
