// A complete read-only conversation for an app that holds a Studio connection.
//
// `transport` is how your app reaches Studio: in Node, `socketTransport()`
// from `@sprintengine/agent-sdk/node` reaches the owner socket on this
// machine; in a desktop shell you write, whatever carries frames to it. The
// token is the one your app was paired with in Studio's Settings.
import React, { useEffect, useState } from 'react'

import { connect, type StudioClient, type StudioTransportFactory } from '@sprintengine/agent-sdk'
import { checkConversationTimelineProtocol } from '@sprintengine/conversation-timeline'
import { ConversationView } from '@sprintengine/conversation-view'

export function ReadOnlyConversation({
  transport,
  token,
  workspaceId,
  agentId,
}: {
  transport: StudioTransportFactory
  token: string
  workspaceId: string
  agentId: string
}): React.JSX.Element {
  const [client, setClient] = useState<StudioClient | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let current: StudioClient | null = null
    let gone = false
    connect({ transport, client: { name: 'Read-only conversation' }, auth: { token } }).then(
      (connected) => {
        current = connected
        if (gone) return void connected.close()
        const supported = checkConversationTimelineProtocol(connected.welcome.conversation)
        if (!supported.ok) setProblem(supported.message)
        else setClient(connected)
      },
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    )
    return () => {
      gone = true
      current?.close()
    }
  }, [transport, token])

  if (problem) return <p role="alert">{problem}</p>
  if (!client) return <p>Connecting to Studio…</p>
  return <ConversationView source={client.conversations} conversation={{ workspaceId, agentId }} />
}
