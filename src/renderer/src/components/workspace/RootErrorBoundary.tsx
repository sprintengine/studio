import React from 'react'

import { PrimaryButton } from '../ui/Buttons'
import { EmptyState } from '../ui/EmptyState'

// The boundary at the top of every window's tree. Without it, one render that
// throws (a reply in a shape a component did not expect, a lazy chunk that
// failed to load) unmounts the whole app and leaves a blank window with no way
// back but a reload nobody is told to do. The surfaces that can fail on their
// own (the doors, the chat) keep their own boundaries; this one is the floor
// under them, and says what happened and how to recover.

type RootErrorBoundaryProps = {
  children: React.ReactNode
  /** Where a reload goes; the page itself unless a host says otherwise (tests). */
  onReload?: () => void
}

type RootErrorBoundaryState = { failed: boolean }

export class RootErrorBoundary extends React.Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // The same tag the window's own error listener uses, so a diagnostics
    // report finds it with the rest.
    console.error('[RendererError]', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: info.componentStack ?? undefined,
    })
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    const reload = this.props.onReload ?? (() => window.location.reload())
    return (
      <div role="alert" className="h-screen w-screen bg-[color:var(--bg-canvas)]">
        <EmptyState
          title="Studio hit a problem and stopped drawing this window."
          body="Your chats and agents keep running. Reload the window to pick up where you were."
          action={<PrimaryButton onClick={reload}>Reload window</PrimaryButton>}
        />
      </div>
    )
  }
}
