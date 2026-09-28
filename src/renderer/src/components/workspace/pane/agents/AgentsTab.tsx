import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { EmptyState, GhostButton, InlineNotice, PanelHeader, RowButton, Spinner, TruncatedText } from '../../../ui'
import { useLocalChatBinding, type ChatBinding } from '../../../panels/agentChat/chatBinding'
import { ConversationLinkProvider } from '../../../panels/agentChat/conversationLinks'
import {
  projectConversation,
  type TranscriptEntry,
  type TranscriptToolEntry,
} from '../../../panels/agentChat/conversationProjection'
import { flattenToolEntries, subagentLaneLabel } from '../../../panels/agentChat/conversationTimeline'
import { LiveElapsed } from '../../../panels/agentChat/liveElapsed'
import { SubagentLaneResult, subagentResultPreview } from '../../../panels/agentChat/subagentResult'
import {
  LaneGlyph,
  laneOutcomeWords,
  laneTask,
  SubagentTypesProvider,
  useSubagentTypeDescription,
} from '../../../panels/agentChat/subagentStatus'
import { WorkTimeline } from '../../../panels/agentChat/timelineRows'
import { useConversationSession } from '../../../panels/agentChat/useConversationSession'
import { useAgentFocusRequest } from './agentsPaneFocus'

// The Agents tab: every agent the focused chat sent off to work, the ones still
// working first, and each one's own thread — what it was asked, the steps it
// took, and what it came back with. It reads the chat's own session (the same
// subscription the chat holds, not a second one), so it is live while the
// agents are and complete for a finished chat.

/** Every agent a transcript spawned, nested ones included, in spawn order. */
export function collectAgentLanes(entries: TranscriptEntry[]): TranscriptToolEntry[] {
  const lanes: TranscriptToolEntry[] = []
  const walk = (tool: TranscriptToolEntry) => {
    if (tool.subagentLane) lanes.push(tool)
    for (const child of tool.children ?? []) walk(child)
  }
  for (const entry of entries) if (entry.kind === 'tool') walk(entry)
  return lanes
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k tokens` : `${count} tokens`
}

export function AgentsTab({ workspaceId }: { workspaceId: string; active: boolean }) {
  const focusedAgentId = useWorkspaceStore((s) => s.focusedAgentByWorkspaceId[workspaceId] ?? null)
  const request = useAgentFocusRequest(workspaceId)
  // A chat that asked for this tab (from one of its agent lanes) is shown until
  // another chat takes focus; otherwise the tab follows the focused chat.
  const [target, setTarget] = useState<{ agentId: string; laneId: string | null; serial: number } | null>(null)
  useEffect(() => {
    if (request) setTarget({ agentId: request.agentId, laneId: request.laneId, serial: request.serial })
  }, [request])
  useEffect(() => {
    setTarget((previous) => (previous && focusedAgentId && previous.agentId !== focusedAgentId ? null : previous))
  }, [focusedAgentId])
  const agentId = target?.agentId ?? focusedAgentId
  const binding = useLocalChatBinding(workspaceId, agentId ?? '')
  const root = binding ? (binding.sessionRoot ?? binding.workspaceRoot) : null

  if (!agentId || !binding || !root) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
        <PanelHeader title="Agents" />
        <EmptyState
          title="No chat in focus"
          body="Open a chat, and the agents it sends off to work show up here: the ones still working, the ones that finished, and what each one did."
        />
      </div>
    )
  }
  return (
    <ChatAgents
      key={`${workspaceId}:${agentId}`}
      workspaceId={workspaceId}
      agentId={agentId}
      root={root}
      binding={binding}
      initialLaneId={target?.laneId ?? null}
      requestSerial={target?.serial ?? 0}
    />
  )
}

function ChatAgents({
  workspaceId,
  agentId,
  root,
  binding,
  initialLaneId,
  requestSerial,
}: {
  workspaceId: string
  agentId: string
  root: string
  binding: ChatBinding
  initialLaneId: string | null
  requestSerial: number
}) {
  const session = useConversationSession(root, workspaceId, agentId)
  // Tokens stream into the same session; the list only needs to keep up, not to
  // refold on every one of them.
  const events = useDeferredValue(session.events)
  const projection = useMemo(() => projectConversation(events), [events])
  const lanes = useMemo(() => collectAgentLanes(projection.entries), [projection.entries])
  const [selected, setSelected] = useState<string | null>(initialLaneId)
  useEffect(() => setSelected(initialLaneId), [initialLaneId, requestSerial])
  const lane = selected ? lanes.find((candidate) => candidate.id === selected) : undefined

  const working = lanes.filter((candidate) => candidate.status === 'running')
  const finished = lanes.filter((candidate) => candidate.status !== 'running').reverse()
  const tokens = lanes.reduce((sum, candidate) => sum + (candidate.agent?.usage?.totalTokens ?? 0), 0)

  return (
    <ConversationLinkProvider workspaceId={workspaceId} agentId={agentId} cwd={root} workspaceRoot={root}>
      <SubagentTypesProvider value={projection.agentTypes}>
        <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
          <PanelHeader title="Agents" subtitle={binding.agent.name} count={lanes.length || undefined} />
          {lane ? (
            <AgentThread lane={lane} onBack={() => setSelected(null)} />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
              {!session.hydrated && !session.error ? (
                <div className="flex items-center gap-2 px-2 py-3 text-meta text-[color:var(--text-muted)]">
                  <Spinner />
                  <span role="status">Reading the chat…</span>
                </div>
              ) : null}
              {session.error ? (
                <InlineNotice tone="error" title="Couldn't read this chat." detail={session.error} />
              ) : null}
              {session.hydrated && lanes.length === 0 ? (
                <EmptyState
                  title="No agents yet"
                  body="When this chat sends agents off to work — to search the code, plan, or take on part of a task — they show up here."
                />
              ) : null}
              {working.length > 0 ? <AgentSection title="Working" lanes={working} onOpen={setSelected} /> : null}
              {finished.length > 0 ? <AgentSection title="Finished" lanes={finished} onOpen={setSelected} /> : null}
              {session.hasMore ? (
                <GhostButton
                  size="inline"
                  tone="subtle"
                  align="start"
                  disabled={session.loadingEarlier}
                  onClick={() => void session.loadEarlier().catch(() => undefined)}
                  className="mx-2 mt-2"
                >
                  {session.loadingEarlier ? 'Loading earlier turns…' : 'Load earlier turns to see older agents'}
                </GhostButton>
              ) : null}
            </div>
          )}
          {lanes.length > 0 && !lane ? (
            <footer className="border-t border-[color:var(--border-subtle)] px-4 py-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
              {[
                working.length ? `${working.length} working` : null,
                finished.length ? `${finished.length} finished` : null,
                tokens ? formatTokens(tokens) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </footer>
          ) : null}
        </div>
      </SubagentTypesProvider>
    </ConversationLinkProvider>
  )
}

function AgentSection({
  title,
  lanes,
  onOpen,
}: {
  title: string
  lanes: TranscriptToolEntry[]
  onOpen: (laneId: string) => void
}) {
  return (
    <section aria-label={title} className="mb-3">
      <h3 className="px-2 pb-1 pt-2 text-micro font-medium text-[color:var(--text-subtle)]">
        {title} · {lanes.length}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {lanes.map((lane) => (
          <li key={lane.id}>
            <AgentRow lane={lane} onOpen={() => onOpen(lane.id)} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function AgentStatus({ lane }: { lane: TranscriptToolEntry }) {
  if (lane.status === 'running')
    return (
      <span className="text-[color:var(--accent-primary)]">
        Working{lane.startedAt !== undefined ? ' · ' : ''}
        {lane.startedAt !== undefined ? <LiveElapsed startedAt={lane.startedAt} /> : null}
      </span>
    )
  return (
    <span className={lane.outputStatus === 'error' ? 'text-[color:var(--tone-error)]' : undefined}>
      {laneOutcomeWords(lane)}
    </span>
  )
}

// One agent in the list: who it is and what it was sent to do, how it is doing,
// and underneath, what it is doing now or the first line of what it found.
function AgentRow({ lane, onOpen }: { lane: TranscriptToolEntry; onOpen: () => void }) {
  const running = lane.status === 'running'
  const task = laneTask(lane)
  const now = lane.agent?.progressSummary ?? (lane.agent?.lastToolName ? `Using ${lane.agent.lastToolName}` : '')
  const detail = running ? now : lane.agent?.error || subagentResultPreview(lane.output)
  return (
    <RowButton density="row" onClick={onOpen} aria-label={`${subagentLaneLabel(lane)}: ${task || 'agent'}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-meta">
          <LaneGlyph tool={lane} />
          <span className={`shrink-0 ${running ? 'font-medium text-[color:var(--text-default)]' : ''}`}>
            {subagentLaneLabel(lane)}
          </span>
          {task ? <TruncatedText as="span" text={task} className="min-w-0 text-[color:var(--text-muted)]" /> : null}
          <span className="ml-auto shrink-0 pl-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
            <AgentStatus lane={lane} />
          </span>
        </span>
        {detail ? (
          <TruncatedText
            as="span"
            text={detail}
            className={`min-w-0 pl-6 text-micro ${lane.agent?.error && !running ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'}`}
          />
        ) : null}
      </span>
    </RowButton>
  )
}

// One agent's own thread: what it was asked and what kind of helper it is, the
// steps it took (each one opens onto its input and output, as in the chat),
// and the report it came back with.
function AgentThread({ lane, onBack }: { lane: TranscriptToolEntry; onBack: () => void }) {
  const running = lane.status === 'running'
  const description = useSubagentTypeDescription(lane.subagentType)
  const task = laneTask(lane)
  const steps = lane.children ?? []
  const tokens = lane.agent?.usage?.totalTokens
  const stepCount = lane.agent?.usage?.toolUses ?? flattenToolEntries(steps).length
  const now = lane.agent?.progressSummary ?? (lane.agent?.lastToolName ? `Using ${lane.agent.lastToolName}` : '')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-2">
      <GhostButton size="inline" tone="subtle" align="start" onClick={onBack}>
        ‹ All agents
      </GhostButton>
      <div className="mt-2 flex items-center gap-2 px-2 text-body">
        <LaneGlyph tool={lane} />
        <span className="font-medium text-[color:var(--text-strong)]">{subagentLaneLabel(lane)}</span>
        <span className="ml-auto shrink-0 text-meta tabular-nums text-[color:var(--text-subtle)]">
          <AgentStatus lane={lane} />
        </span>
      </div>
      <dl className="mt-2 flex flex-col gap-1 px-2 text-meta">
        {task ? (
          <div>
            <dt className="sr-only">Task</dt>
            <dd className="text-[color:var(--text-default)]">{task}</dd>
          </div>
        ) : null}
        {description ? (
          <div>
            <dt className="sr-only">Kind of agent</dt>
            <dd className="text-[color:var(--text-muted)]">{description}</dd>
          </div>
        ) : null}
        {running && now ? (
          <div>
            <dt className="sr-only">Now</dt>
            <dd className="text-[color:var(--text-muted)]">Now: {now}</dd>
          </div>
        ) : null}
        {!running && lane.agent?.error ? (
          <div>
            <dt className="sr-only">Why it ended</dt>
            <dd className="text-[color:var(--tone-error)]">{lane.agent.error}</dd>
          </div>
        ) : null}
        {stepCount || tokens ? (
          <div>
            <dt className="sr-only">Usage</dt>
            <dd className="text-micro text-[color:var(--text-subtle)]">
              {[
                stepCount ? `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}` : null,
                tokens ? formatTokens(tokens) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </div>
        ) : null}
      </dl>
      <h3 className="mt-4 px-2 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Steps</h3>
      {steps.length > 0 ? (
        <div className="px-1">
          <WorkTimeline tools={steps} live={running} />
        </div>
      ) : (
        <p className="px-2 text-meta text-[color:var(--text-subtle)]">
          {running ? 'No steps yet — it is still getting started.' : 'It took no steps of its own.'}
        </p>
      )}
      {!running ? (
        <>
          <h3 className="mt-4 px-2 pb-1 text-micro font-medium text-[color:var(--text-subtle)]">Report</h3>
          <SubagentLaneResult tool={lane} />
        </>
      ) : null}
    </div>
  )
}
