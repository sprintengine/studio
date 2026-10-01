import { useCallback, useEffect, useState } from 'react'

import type {
  ModuleConversationResult,
  ModuleConversationSummary,
  ModuleWorkspaceView,
  RendererHost,
} from '@sprintengine/module-sdk'
import {
  EmptyState,
  GhostButton,
  InlineNotice,
  PrimaryButton,
  RowButton,
  Section,
  Select,
} from '@sprintengine/module-sdk/ui'
import { GlobalSurfaceShell, useSurfaceBackNav } from '@sprintengine/module-sdk/surface'

import { CHANGED_TOPIC, CHANNELS } from './protocol'

const STATUS_WORDS: Record<ModuleConversationSummary['status'], string> = {
  starting: 'Starting',
  ready: 'Waiting for you',
  active: 'Working',
  awaiting_approval: 'Needs your approval',
  stopped: 'Stopped',
  failed: 'Failed',
  absent: 'Not running',
}

export function createCompanion(host: RendererHost) {
  return function Companion() {
    const { onBack, canGoBack } = useSurfaceBackNav()
    const [workspaces, setWorkspaces] = useState<ModuleWorkspaceView[]>([])
    const [workspaceId, setWorkspaceId] = useState<string | null>(null)
    const [chats, setChats] = useState<ModuleConversationSummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const reload = useCallback(async () => {
      try {
        setChats((await host.invoke(CHANNELS.list)) as ModuleConversationSummary[])
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }, [])

    useEffect(() => host.watchWorkspaces(setWorkspaces), [])
    useEffect(() => {
      void reload()
      return host.subscribe(CHANGED_TOPIC, () => void reload())
    }, [reload])

    const target = workspaceId ?? workspaces[0]?.id ?? null

    const summarise = async () => {
      if (!target) return
      setBusy(true)
      setError(null)
      const result = (await host.invoke(CHANNELS.start, { workspaceId: target })) as ModuleConversationResult<{
        conversation: ModuleConversationSummary
      }>
      setBusy(false)
      if (!result.ok) setError(result.message)
      else host.focusTab({ workspaceId: target, kind: 'chat', id: result.conversation.agentId })
    }

    // openChat puts the prompt in a new chat's composer as a draft: the person
    // reads it and sends it (pass `send: true` to send it for them).
    const draft = async () => {
      if (!target) return
      const opened = await host.openChat({
        workspaceId: target,
        prompt: 'Help me plan the next change to this project.',
      })
      if (!opened.ok) setError(opened.message)
    }

    if (!host.supports('conversations')) {
      return (
        <GlobalSurfaceShell
          ariaLabel="{{displayName}}"
          bar={{ title: '{{displayName}}' }}
          onBack={onBack}
          canGoBack={canGoBack}
        >
          <InlineNotice tone="warn" title="Chats are not available">
            This version of SprintEngine Studio does not offer chats to extensions.
          </InlineNotice>
        </GlobalSurfaceShell>
      )
    }

    return (
      <GlobalSurfaceShell
        ariaLabel="{{displayName}}"
        bar={{
          title: '{{displayName}}',
          actions: (
            <>
              {host.supports('chat.open') ? (
                <GhostButton size="sm" disabled={!target} onClick={() => void draft()}>
                  Open a chat draft
                </GhostButton>
              ) : null}
              <PrimaryButton size="sm" disabled={!target} busy={busy} onClick={() => void summarise()}>
                Summarise this project
              </PrimaryButton>
            </>
          ),
        }}
        onBack={onBack}
        canGoBack={canGoBack}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
          <Select
            ariaLabel="Workspace"
            items={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
            value={target}
            onChange={setWorkspaceId}
            placeholder="No workspace open"
          />
          {error ? <InlineNotice tone="error" title={error} /> : null}
          <Section title="Chats this extension started" count={chats.length}>
            {chats.length === 0 ? (
              <EmptyState density="list" title="None yet" body="Summarise a project to start one." />
            ) : (
              chats.map((chat) => (
                <RowButton
                  key={chat.agentId}
                  onClick={() => host.focusTab({ workspaceId: chat.workspaceId, kind: 'chat', id: chat.agentId })}
                >
                  {chat.name} · {STATUS_WORDS[chat.status]}
                </RowButton>
              ))
            )}
          </Section>
        </div>
      </GlobalSurfaceShell>
    )
  }
}
