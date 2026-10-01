// The chat view's own error boundary. A chat renders whatever its agent and
// its transport hand it: a malformed reply, an event of a shape nobody
// expected, a lazy chunk that failed to load. Any of those throwing during
// render used to unmount everything up to the root and leave a blank window.
// Here the failure stays in the chat's pane: it says the chat stopped, that
// nothing else did, and offers to draw the chat again from what the runtime
// holds, which is the same as reopening it.

import React from 'react'

import { GhostButton, InlineNotice } from '../../ui'

type ChatViewErrorBoundaryProps = {
  /** The chat shown; a different chat in the same pane starts clean. */
  chatKey: string
  children: React.ReactNode
}

type ChatViewErrorBoundaryState = { failed: boolean; detail: string | null }

// What the chat threw, first line only and bounded: a message can carry a
// path or a payload, and the notice is not the place to read either whole.
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split('\n', 1)[0]?.trim() || 'The chat failed to render.').slice(0, 300)
}

export class ChatViewErrorBoundary extends React.Component<ChatViewErrorBoundaryProps, ChatViewErrorBoundaryState> {
  state: ChatViewErrorBoundaryState = { failed: false, detail: null }

  static getDerivedStateFromError(error: unknown): ChatViewErrorBoundaryState {
    return { failed: true, detail: describeError(error) }
  }

  componentDidCatch(error: unknown): void {
    console.error('[chat] the chat view crashed', error)
  }

  componentDidUpdate(previous: ChatViewErrorBoundaryProps): void {
    // A pane that moves to another chat must not carry this one's failure.
    if (previous.chatKey !== this.props.chatKey && this.state.failed) {
      // oxlint-disable-next-line react/no-did-update-set-state -- guarded reset, runs once per switch
      this.setState({ failed: false, detail: null })
    }
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <ChatViewErrorFallback
        detail={this.state.detail}
        onRetry={() => this.setState({ failed: false, detail: null })}
      />
    )
  }
}

// Exported so the failure surface is testable without a real render error.
export function ChatViewErrorFallback({ detail, onRetry }: { detail: string | null; onRetry: () => void }) {
  return (
    <div className="p-3">
      <InlineNotice
        tone="error"
        title="This chat hit a problem and stopped. The rest of the app is unaffected."
        hint="Reload the chat to draw it again; its conversation is kept."
        {...(detail ? { detail } : {})}
        action={<GhostButton onClick={onRetry}>Reload chat</GhostButton>}
      />
    </div>
  )
}
