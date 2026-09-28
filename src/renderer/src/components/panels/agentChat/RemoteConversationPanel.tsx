import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import type {
  MeshConversation,
  MeshConversationAccess,
  MeshConversationKey,
  MeshConversationLink,
} from '../../../../../shared/tailnet-mesh'
import { RemoteMachineGlyph } from '../../AppIcons'
import { TruncatedText } from '../../ui'
import type { CliRuntimeOption } from '../../ui/CliModelPicker'
import { ConversationChatBody } from '../AgentChatView'
import type { ChatBinding, ChatAgentFields } from './chatBinding'
import type { ChatReadiness } from './chatStates'
import {
  ConversationTransportProvider,
  createRemoteConversationTransport,
  type ConversationTransportCapabilities,
} from './conversationTransport'

// A conversation on a paired machine, in the regular chat view.
//
// The transcript, pending requests and composer are the chat view's own; what
// this pane adds is the transport (main follows the conversation over the
// tailnet and keeps its tail, so a reconnect or a restart resumes rather than
// replays) and the agent fields a local chat keeps in its record. The machine
// is named above the transcript and on the tab, so a keystroke here is never
// mistaken for one on this machine.
//
// Readiness is the link's: live and allowed to operate is ready; live and
// read-only shows the conversation with the composer closed and says why; a
// link that is reconnecting keeps the transcript on screen and says so.

type Props = {
  /** The workspace here that holds this pane. */
  workspaceId: string
  connectionId: string
  machineName: string
  /** The conversation's ids on that machine. */
  remoteWorkspaceId: string
  remoteAgentId: string
  /** What the row it was opened from called it, until the machine is read. */
  title?: string
}

function remoteConversationReadiness(
  link: MeshConversationLink | null,
  access: MeshConversationAccess | null,
  machineName: string,
): ChatReadiness {
  if (!link) return { kind: 'error', message: `Connecting to ${machineName}.` }
  if (link.state !== 'live') return { kind: 'error', message: link.detail }
  if (access !== 'operate')
    return {
      kind: 'error',
      message: `This pairing may follow this conversation on ${machineName} but not drive it.`,
    }
  return { kind: 'ready' }
}

/**
 * The chat's CLI row as the machine running it lists it: its name and the
 * models its own picker offers, which are the only ones it will switch to.
 * Null for a machine that does not offer model switching, or a chat whose
 * provider is not a CLI; the chip then shows the model it is on, locked.
 */
function remoteConversationEngine(thread: MeshConversation | null, modelSwitch: boolean): CliRuntimeOption | null {
  const models = modelSwitch ? thread?.models : undefined
  if (!models) return null
  return {
    value: models.cli,
    label: models.cliLabel,
    modelSelection: { options: models.options, allowCustomId: false },
  }
}

/** The session a remote row stands for, as the chat view reads one: what that machine said it can do. */
function remoteConversationSession(
  thread: MeshConversation | null,
  key: MeshConversationKey,
  modelSwitch: boolean,
): ConversationSessionSummary {
  const capabilities = thread?.capabilities
  return {
    // A session id, even for a conversation with none live over there: a
    // remote send resumes one, so the view never starts one here.
    sessionId: thread?.sessionId ?? `remote:${key.agentId}`,
    workspaceId: key.workspaceId,
    agentId: key.agentId,
    providerId: thread?.providerId ?? '',
    modelId: thread?.modelId ?? '',
    status: 'ready',
    // The preset the machine says the conversation is on. With it the chat
    // shows the same switcher a local chat does; without it (a desktop built
    // before the list named it) the switcher stays hidden.
    ...(thread?.permissionPreset ? { permissionPreset: thread.permissionPreset } : {}),
    createdAt: thread?.createdAt ?? 0,
    updatedAt: thread?.updatedAt ?? 0,
    capabilities: {
      tools: true,
      approvals: capabilities?.approvals ?? true,
      questions: capabilities?.questions ?? true,
      // The remote send carries no mode or effort, and images need an upload
      // path this view does not drive yet.
      planMode: false,
      images: false,
      skills: 'none',
      reasoningEfforts: null,
      interrupt: capabilities?.interrupt ?? true,
      resume: false,
      subagents: true,
      cost: false,
      contextMeter: false,
      // Whether the machine will take a new model mid-conversation, as its
      // list says; a machine that does not offer model switching never will.
      liveModelSwitch: modelSwitch && thread?.models?.liveModelSwitch === true,
      checkpoints: capabilities?.checkpoints ?? false,
    },
  }
}

export default function RemoteConversationPanel({
  workspaceId,
  connectionId,
  machineName,
  remoteWorkspaceId,
  remoteAgentId,
  title,
}: Props) {
  const key = useMemo<MeshConversationKey>(
    () => ({ connectionId, workspaceId: remoteWorkspaceId, agentId: remoteAgentId }),
    [connectionId, remoteWorkspaceId, remoteAgentId],
  )
  const [link, setLink] = useState<MeshConversationLink | null>(null)
  const [thread, setThread] = useState<MeshConversation | null>(null)
  const [listedAccess, setListedAccess] = useState<MeshConversationAccess | null>(null)
  // The machine advertises model switching and lists this chat's catalog.
  const [listedModelSwitch, setListedModelSwitch] = useState(false)
  const modelSwitch = listedModelSwitch && Boolean(thread?.models)
  // Bumped after an accepted model switch, so the list is read again and the
  // chip names what the machine says the chat is now on.
  const [listVersion, setListVersion] = useState(0)
  // The link's word on access is the latest (a refused command narrows it);
  // the list's is what was granted when this pane last read the machine.
  const access = link?.access ?? listedAccess

  // One transport per conversation, never rebuilt on a grant change: a new
  // transport is a new subscription, and the follow in main would be dropped
  // and dialled again. Its capabilities read the access as it is now.
  const accessRef = useRef(access)
  accessRef.current = access
  const modelSwitchRef = useRef(modelSwitch)
  modelSwitchRef.current = modelSwitch
  const transport = useMemo(() => {
    const base = createRemoteConversationTransport({ key, machineName, access: null, onLink: setLink })
    const capabilities = base.capabilities
    const setModel = base.setModel
    return {
      ...base,
      get capabilities(): ConversationTransportCapabilities {
        return { ...capabilities, operate: accessRef.current === 'operate', modelSwitch: modelSwitchRef.current }
      },
      ...(setModel
        ? {
            setModel: async (change: Parameters<typeof setModel>[0]) => {
              const result = await setModel(change)
              if (result.ok) setListVersion((version) => version + 1)
              return result
            },
          }
        : {}),
    }
  }, [key, machineName])

  // The machine's list names the conversation's title, model and what its
  // provider can do. Read on open and whenever the link comes back live.
  const live = link?.state === 'live'
  useEffect(() => {
    let cancelled = false
    void window.api
      .meshConversationList(connectionId)
      .then((result) => {
        if (cancelled || !result.ok) return
        setListedAccess(result.access)
        setListedModelSwitch(result.modelSwitch === true)
        setThread(
          result.conversations.find(
            (entry) => entry.workspaceId === remoteWorkspaceId && entry.agentId === remoteAgentId,
          ) ?? null,
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connectionId, remoteWorkspaceId, remoteAgentId, live, listVersion])

  const [fields, setFields] = useState<Omit<ChatAgentFields, 'conversation' | 'name'>>({})
  const update = useCallback((patch: Partial<ChatAgentFields>) => {
    const { conversation, name: _name, ...rest } = patch
    setFields((current) => ({ ...current, ...rest }))
    // The chat view records a model only once the machine accepted the
    // switch; the chip moves now, and the list read that follows confirms it.
    // The CLI is the machine's to say, never this pane's.
    if (conversation?.modelId)
      setThread((current) => (current ? { ...current, modelId: conversation.modelId } : current))
  }, [])
  const displayTitle = thread?.title || title || 'Conversation'
  const session = useMemo(() => remoteConversationSession(thread, key, modelSwitch), [thread, key, modelSwitch])
  const engine = useMemo(() => remoteConversationEngine(thread, modelSwitch), [thread, modelSwitch])
  const readiness = useMemo(() => remoteConversationReadiness(link, access, machineName), [link, access, machineName])
  const binding = useMemo<ChatBinding>(
    () => ({
      agent: {
        ...fields,
        name: displayTitle,
        conversation: { providerId: thread?.providerId ?? '', modelId: thread?.modelId ?? '' },
      },
      update,
      workspace: null,
      workspaceRoot: null,
      sessionRoot: `mesh:${connectionId}`,
      readiness,
      session,
      ...(engine ? { engine } : {}),
      header: (
        <div className="flex min-w-0 items-center gap-1.5 px-4 pt-2 text-meta text-[color:var(--text-muted)]">
          <RemoteMachineGlyph className="icon-xs shrink-0" />
          <TruncatedText as="span" text={displayTitle} className="min-w-0 text-[color:var(--text-default)]" />
          <span className="shrink-0">· On {machineName}</span>
        </div>
      ),
    }),
    [fields, displayTitle, thread, update, connectionId, readiness, session, engine, machineName],
  )

  return (
    <ConversationTransportProvider value={transport}>
      <ConversationChatBody
        key={`${connectionId}:${remoteWorkspaceId}:${remoteAgentId}`}
        workspaceId={workspaceId}
        agentId={remoteAgentId}
        binding={binding}
      />
    </ConversationTransportProvider>
  )
}
