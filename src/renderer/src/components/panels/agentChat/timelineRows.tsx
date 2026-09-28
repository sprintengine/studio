// The rows of the chat timeline: user turns, assistant turns, the work
// timeline with its subagent lanes, errors and resolved decisions.

import {
  type ConversationTimelineRow,
  type ConversationDecisionRow,
  flattenToolEntries,
  toolObject,
  subagentLaneLabel,
} from './conversationTimeline'
import { type ReasoningSegment, type TranscriptEntry, type TranscriptToolEntry } from './conversationProjection'
import { AttachmentThumbnail } from '../ComposerAttachmentStrip'
import { StoredAttachmentThumbnail } from './storedAttachments'
import { Badge, TruncatedText, GhostButton, StatusDot, RowButton, OutlineButton, LinkButton, Tooltip } from '../../ui'
import { ConversationFileLink, ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import { stepWentWrong, ToolRow, toolGlyphInk, toolPresentationInput } from './toolRows/ToolRow'
import { useConversationDisclosure } from './conversationViewState'
import { presentToolItem, summarizeToolGroup } from '../../../../../shared/conversation/presentation'
import type { ConversationToolKind } from '../../../../../shared/conversation-runtime'
import { deriveTurnFold } from './turnFolds'
import { copyToClipboardWithToast } from '../../../utils/copyToClipboardWithToast'
import { useLiveRowMotion } from './liveVisibility'
import { formatMessageTime, LiveElapsed } from './liveElapsed'
import { ReasoningBlock } from './reasoningBlock'
import { CompactionDivider, TurnMeta } from './turnMeta'
import { ChevronRightGlyph, ToolKindGlyph } from './toolRows/ToolKindGlyph'
import { ChangedFilesCard, hasTurnChanges, RevertTurnAction } from './changedFilesCard'
import { EditFromHereAction, type EditFromHereDraft } from './editFromHere'
import { ResolvedPlanCard } from './planCard'
import { SubagentLaneResult, subagentModel, subagentOutcomeWord } from './subagentResult'
import React, { useState, useRef } from 'react'

export function formatStepDuration(ms: number): string {
  if (ms < 950) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  // Rounded once, before it is split: rounding the remainder alone turns
  // 1m 59.7s into "1m 60s".
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// Auth-shaped turn failures get a `claude login` hint in the error block.
export function isAuthShapedFailure(reason: string | undefined): boolean {
  return Boolean(reason && /auth|login|oauth|credential|401|expired|api key/i.test(reason))
}

// Chrome the timeline rows need from the component: who is speaking, how to
// name models, and where Retry routes.
export type TimelineChrome = {
  checkpointsEnabled?: boolean
  conversationRunning?: boolean
  checkpointSeqs?: ReadonlySet<number>
  latestTurnId?: string
  assistantName: string
  // Only the latest failed turn is retryable (retry re-sends the last message).
  retryTurnId?: string
  onRetry: () => void
  retryDisabled: boolean
  // The provider can go back to before a user message ("Edit from here"), and
  // where that puts the message once it has: back into the composer.
  rewindEnabled?: boolean
  onRestoreDraft?: (draft: EditFromHereDraft) => void
}

export const TimelineRow = React.memo(function TimelineRow({
  row,
  chrome,
}: {
  row: ConversationTimelineRow
  chrome: TimelineChrome
}) {
  return (
    <div className="group/conversation" data-conversation-row-kind={row.kind}>
      {row.kind === 'user' ? <UserTimelineRow entry={row.entry} chrome={chrome} /> : null}
      {row.kind === 'assistant' ? (
        <AssistantTurnBlock
          entry={row.entry}
          tools={row.tools}
          decisions={row.decisions}
          chrome={chrome}
          modelSwitched={row.modelSwitched}
        />
      ) : null}
      {row.kind === 'compaction' ? <CompactionDivider entry={row.entry} /> : null}
      {row.kind === 'approval' ? <ResolvedDecisions rows={row.decisions} className="pb-6" /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
})

// User message: quiet right-aligned card that hugs what was sent. The clock,
// Copy and Revert sit on a line under the card rather than inside it — inside,
// their width and row height set the card's size, so "hi" sat in a tall wide
// box. The card's right edge is the transcript column's right edge, the same
// edge the composer and the assistant's text keep. Images sent with the turn sit
// above the text; an image-only turn renders no empty text line. A bubble
// replayed from the transcript reads its images back from the attachment store.
export function UserTimelineRow({
  entry,
  chrome,
}: {
  entry: Extract<TranscriptEntry, { kind: 'user' }>
  chrome?: TimelineChrome
}) {
  const attachments = entry.attachments ?? []
  const stored = attachments.length ? [] : (entry.storedAttachments ?? [])
  return (
    <div className="flex flex-col items-end pb-6">
      <MessageAuthorHeading>You said</MessageAuthorHeading>
      <div className="max-w-[76%] rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-1.5">
        {attachments.length > 0 || stored.length > 0 ? (
          <div className={`flex flex-wrap justify-end gap-1.5 ${entry.text ? 'mb-2' : ''}`}>
            {attachments.map((attachment) => (
              <AttachmentThumbnail key={attachment.id} attachment={attachment} className="h-16 w-16" />
            ))}
            {stored.map((attachment) => (
              <StoredAttachmentThumbnail key={attachment.ref} attachment={attachment} className="h-16 w-16" />
            ))}
          </div>
        ) : null}
        {entry.mentions?.length || entry.skills?.length ? (
          <div className="mb-2 flex flex-wrap justify-end gap-1.5" aria-label="Attached context">
            {entry.skills?.map((skill) => (
              <Badge key={`skill:${skill}`} ariaLabel={`Skill: ${skill}`}>
                {skill}
              </Badge>
            ))}
            {entry.mentions?.map((mention) =>
              mention.kind === 'folder' ? (
                <Badge key={`folder:${mention.path}`} ariaLabel={`Folder: ${mention.path}`}>
                  {mention.path}/
                </Badge>
              ) : (
                <ConversationFileLink
                  key={`${mention.path}:${mention.line ?? ''}`}
                  token={`./${mention.path}${mention.line ? `:${mention.line}` : ''}`}
                  source="inlineCode"
                  variant="chip"
                />
              ),
            )}
          </div>
        ) : null}
        {entry.text ? <UserMessageBody id={entry.id} text={entry.text} /> : null}
      </div>
      <div className="mt-1 flex items-center justify-end gap-2">
        <MessageTimestamp at={entry.createdAt} />
        <GhostButton
          size="inline"
          className="opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
          onClick={() => void copyToClipboardWithToast(entry.text)}
        >
          Copy
        </GhostButton>
        {chrome?.checkpointsEnabled &&
        entry.seq &&
        chrome.checkpointSeqs?.has(entry.seq) &&
        (!entry.reverted || entry.undoRevertSeq !== undefined) ? (
          <RevertTurnAction
            turnSeq={entry.reverted ? (entry.undoRevertSeq ?? entry.seq) : entry.seq}
            reverted={entry.reverted}
            overwritesLaterWork={entry.undoOverwritesLaterWork}
            running={chrome.conversationRunning ?? false}
            className="opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
          />
        ) : null}
        {chrome?.rewindEnabled && chrome.onRestoreDraft ? (
          <EditFromHereAction
            entry={entry}
            running={chrome.conversationRunning ?? false}
            canRestoreFiles={Boolean(chrome.checkpointsEnabled && entry.seq && chrome.checkpointSeqs?.has(entry.seq))}
            onRestoreDraft={chrome.onRestoreDraft}
            className="opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
          />
        ) : null}
      </div>
    </div>
  )
}

// Screen readers skim a transcript by heading, so each message announces who
// wrote it as one. Visually hidden and kept out of a selection, so neither the
// page nor copied text changes.
function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>
}

// A pasted log or file reads as a wall in the transcript, so past either of
// these a message folds to its first lines under a fade until asked for. What
// counts is what was typed, not how it wraps, so a narrow pane folds the same
// messages a wide one does.
export const COLLAPSED_USER_MESSAGE_CHARS = 600
export const COLLAPSED_USER_MESSAGE_LINES = 8

export function shouldCollapseUserMessage(text: string): boolean {
  if (!text.trim()) return false
  return text.length > COLLAPSED_USER_MESSAGE_CHARS || text.split('\n').length > COLLAPSED_USER_MESSAGE_LINES
}

// The bubble keeps its own type rather than the document scale the reply is
// read at: prose at body size in strong ink, blocks closer together, headings
// no larger than the text around them, and no margin under the last block.
const USER_MESSAGE_PROSE =
  '[&_p]:mb-2 [&_p]:text-body [&_p]:leading-normal [&_p]:text-[color:var(--text-strong)] ' +
  '[&_ul]:mb-2 [&_ul]:space-y-0.5 [&_ul]:text-body [&_ul]:leading-normal [&_ul]:text-[color:var(--text-strong)] ' +
  '[&_ol]:mb-2 [&_ol]:space-y-0.5 [&_ol]:text-body [&_ol]:leading-normal [&_ol]:text-[color:var(--text-strong)] ' +
  '[&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-body [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-body ' +
  '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-body [&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-body ' +
  '[&_h5]:mb-1 [&_h5]:mt-3 [&_h5]:text-body [&_h6]:mb-1 [&_h6]:mt-3 [&_h6]:text-body ' +
  '[&_.markdown-rendered>:first-child]:mt-0 [&_.markdown-rendered>:last-child]:mb-0'

// The message as markdown, so a pasted fence is highlighted code and a list
// is a list, with every newline kept as typed. Folded, it keeps its first
// lines under a fade; the disclosure is remembered per message.
function UserMessageBody({ id, text }: { id: string; text: string }) {
  const context = useConversationLinkContext()
  const collapsible = shouldCollapseUserMessage(text)
  const [expanded, setExpanded] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `user-message:${id}`,
    false,
  )
  const collapsed = collapsible && !expanded
  return (
    <div className="min-w-0">
      <div
        data-user-message-collapsed={collapsed ? 'true' : 'false'}
        className={`min-w-0 text-body text-[color:var(--text-strong)] ${USER_MESSAGE_PROSE} ${
          collapsed
            ? 'max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%_-_var(--sem-space-xl)),transparent)]'
            : ''
        }`}
      >
        <ConversationMarkdown text={text} userText />
      </div>
      {collapsible ? (
        <GhostButton
          size="inline"
          tone="subtle"
          align="start"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="mt-1"
        >
          {expanded ? 'Show less' : 'Show full message'}
        </GhostButton>
      ) : null}
    </div>
  )
}

// One assistant turn: work timeline (with the reasoning and prose that came
// between its steps) → closing reasoning → decisions → prose → meta line.
// Glyph-led, no avatar bubble; the reading text gets real size, chrome stays
// small and quiet.
export function AssistantTurnBlock({
  entry,
  tools,
  decisions,
  chrome,
  modelSwitched = false,
}: {
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>
  tools: Extract<TranscriptEntry, { kind: 'tool' }>[]
  decisions: ConversationDecisionRow[]
  chrome: TimelineChrome
  modelSwitched?: boolean
}) {
  const context = useConversationLinkContext()
  const fold = deriveTurnFold(entry, tools, !chrome.latestTurnId || chrome.latestTurnId === entry.turnId)
  const [workOpen, setWorkOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `fold:${entry.turnId}`,
    !fold?.defaultFolded,
  )
  return (
    <div className="pb-6">
      <MessageAuthorHeading>{chrome.assistantName}</MessageAuthorHeading>
      {/* No byline: the tab already says which agent this is, as it does for a
          terminal agent, and the model is on the composer's engine chip. The
          meta line under the reply names it again only after a switch. */}
      {fold ? (
        <GhostButton
          size="inline"
          tone="subtle"
          aria-expanded={workOpen}
          aria-label={fold.failed ? `${fold.label}, ${fold.failed} failed` : undefined}
          onClick={() => setWorkOpen(!workOpen)}
        >
          {fold.label}
          {fold.failed ? <span className="text-[color:var(--tone-error)]">· {fold.failed} failed</span> : null}
        </GhostButton>
      ) : null}
      {tools.length > 0 ? (
        <WorkTimeline
          tools={fold && !workOpen ? tools.filter((tool) => tool.status === 'running') : tools}
          live={entry.status === 'streaming'}
          intermediateText={fold && !workOpen ? undefined : entry.intermediateText}
          reasoning={fold && !workOpen ? undefined : entry.reasoningSegments}
          turnId={entry.turnId}
        />
      ) : null}
      {/* Thinking since the last step: the whole turn's when it ran none. */}
      {(!fold || workOpen) && entry.reasoning.trim() ? (
        <ReasoningBlock
          text={entry.reasoning}
          duration={entry.reasoningDurationMs !== undefined ? formatStepDuration(entry.reasoningDurationMs) : undefined}
          live={entry.status === 'streaming' && entry.reasoningLive === true}
          disclosureId={entry.turnId}
        />
      ) : null}
      <ResolvedDecisions rows={decisions} className={entry.text.trim() ? 'mb-3' : undefined} />
      {entry.text.trim() ? (
        // The pane's full width, as the composer below it: the column's edges
        // are the list's own padding, so prose, code blocks and tool rows all
        // share them with the user's bubble. Selecting in it offers a quote
        // into the composer (quoteSelection).
        <div className="min-w-0" data-quote-source="">
          <ConversationMarkdown text={entry.text} streaming={entry.status === 'streaming'} />
        </div>
      ) : null}
      {entry.status === 'interrupted' ? (
        <span className="text-micro text-[color:var(--text-subtle)]">Interrupted</span>
      ) : null}
      {entry.status !== 'streaming' ? (
        <div className="flex items-center gap-2 text-meta text-[color:var(--sem-color-text-muted)]">
          {entry.durationMs !== undefined ? <span>{formatStepDuration(entry.durationMs)}</span> : null}
          <TurnMeta entry={entry} modelSwitched={modelSwitched} />
          <MessageTimestamp at={entry.startedAt} />
          <GhostButton
            size="inline"
            className="opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
            onClick={() =>
              void copyToClipboardWithToast(
                [...(entry.intermediateText?.map((part) => part.text) ?? []), entry.text].filter(Boolean).join('\n\n'),
              )
            }
          >
            Copy
          </GhostButton>
        </div>
      ) : null}
      {entry.status === 'failed' ? <TurnErrorBlock entry={entry} chrome={chrome} /> : null}
      {chrome.checkpointsEnabled &&
      entry.status !== 'streaming' &&
      hasTurnChanges(entry.checkpointAvailable, entry.checkpointSummary) &&
      entry.checkpointTurnSeq &&
      entry.checkpointSummary ? (
        <ChangedFilesCard
          turnSeq={entry.checkpointTurnSeq}
          summary={entry.checkpointSummary}
          running={chrome.conversationRunning ?? false}
          reverted={entry.reverted}
          undoTurnSeq={entry.undoRevertSeq}
          undoOverwritesLaterWork={entry.undoOverwritesLaterWork}
        />
      ) : null}
    </div>
  )
}

// Settled steps share a summary disclosure; live work stays outside it.
// Retained as a compatibility export for consumers measuring old transcript
// fixtures. The viewport now windows rows instead of hiding earlier work.
export const MAX_VISIBLE_WORK_STEPS = 12

// Split a turn's steps where the model paused to think or to write: each part
// opens with the reasoning and prose that came before its first step. A part
// carries `reasoning` only when it has some.
export function partitionWorkTimeline(
  tools: TranscriptToolEntry[],
  intermediateText: { text: string; beforeToolUseId: string }[] = [],
  reasoning: ReasoningSegment[] = [],
): { text: string[]; reasoning?: ReasoningSegment[]; tools: TranscriptToolEntry[] }[] {
  const textBefore = new Map<string, string[]>()
  for (const part of intermediateText) {
    const text = textBefore.get(part.beforeToolUseId) ?? []
    text.push(part.text)
    textBefore.set(part.beforeToolUseId, text)
  }
  const reasoningBefore = new Map<string, ReasoningSegment[]>()
  for (const segment of reasoning) {
    reasoningBefore.set(segment.beforeToolUseId, [...(reasoningBefore.get(segment.beforeToolUseId) ?? []), segment])
  }
  const parts: { text: string[]; reasoning?: ReasoningSegment[]; tools: TranscriptToolEntry[] }[] = []
  for (const tool of tools) {
    const text = textBefore.get(tool.id) ?? []
    const thought = reasoningBefore.get(tool.id)
    if (!parts.length || text.length || thought)
      parts.push({ text, ...(thought ? { reasoning: thought } : {}), tools: [] })
    parts.at(-1)!.tools.push(tool)
  }
  return parts
}

export function WorkTimeline({
  tools,
  live,
  intermediateText,
  reasoning,
  turnId = '',
}: {
  tools: TranscriptToolEntry[]
  live: boolean
  intermediateText?: { text: string; beforeToolUseId: string }[]
  reasoning?: ReasoningSegment[]
  // Scopes each reasoning block's open state to its turn.
  turnId?: string
}) {
  return (
    <div className="mb-2" aria-busy={live}>
      {partitionWorkTimeline(tools, intermediateText, reasoning).map((part) => (
        <React.Fragment key={part.tools[0].id}>
          {part.reasoning?.map((segment) => (
            <ReasoningBlock
              key={`thought:${segment.beforeToolUseId}`}
              text={segment.text}
              duration={segment.durationMs !== undefined ? formatStepDuration(segment.durationMs) : undefined}
              disclosureId={`${turnId}:${segment.beforeToolUseId}`}
            />
          ))}
          {part.text.map((text, index) => (
            <div key={index} className="mb-2 min-w-0">
              <ConversationMarkdown text={text} />
            </div>
          ))}
          <WorkTimelineGroup tools={part.tools} />
        </React.Fragment>
      ))}
    </div>
  )
}

// What a collapsed group says about itself: the kind of step it is mostly made
// of (its glyph) and how many of its steps went wrong, a lane's own steps and a
// command that exited non-zero included. Collapsed is the resting state, so a
// failure inside has to surface on the header or it is hidden.
export function describeToolGroup(tools: TranscriptToolEntry[]): { kind: ConversationToolKind; failed: number } {
  const counts = new Map<ConversationToolKind, number>()
  for (const tool of tools) {
    const kind = presentToolItem(toolPresentationInput(tool)).icon
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const kind = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'
  const failed = flattenToolEntries(tools).filter(stepWentWrong).length
  return { kind, failed }
}

// Settled steps fold behind one quiet summary line, closed until asked for:
// they are how the answer was reached, not the answer, and the prose between
// groups already says what each run of steps was for. Live work stays outside
// the fold so what is happening now is always on screen. A failure inside a
// closed group is the one thing that must not fold away, so the header carries
// it. Opened, the steps scroll inside a bounded rail rather than pushing the
// conversation a screen down.
function WorkTimelineGroup({ tools }: { tools: TranscriptToolEntry[] }) {
  const context = useConversationLinkContext()
  const settled = tools.filter((tool) => tool.status !== 'running')
  const running = tools.filter((tool) => tool.status === 'running')
  const key = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  const [open, setOpen] = useConversationDisclosure(key, `group:${tools[0]?.id ?? ''}`, false)
  const step = (tool: TranscriptToolEntry) => <WorkTimelineStep key={tool.id} tool={tool} />
  const { kind, failed } = describeToolGroup(settled)
  const summary = summarizeToolGroup(settled.map(toolPresentationInput))
  return (
    <>
      {settled.length > 1 ? (
        <>
          <RowButton
            density="row"
            className="group/tool-row text-meta"
            aria-expanded={open}
            aria-label={failed ? `${summary}, ${failed} failed` : undefined}
            onClick={() => setOpen(!open)}
          >
            <span className={`flex shrink-0 ${toolGlyphInk(failed ? 'error' : 'neutral')}`}>
              <ToolKindGlyph kind={kind} />
            </span>
            <span className="min-w-0 truncate text-[color:var(--text-subtle)] group-hover/tool-row:text-[color:var(--text-muted)]">
              {summary}
            </span>
            {failed ? <span className="shrink-0 text-[color:var(--tone-error)]">· {failed} failed</span> : null}
            <ChevronRightGlyph
              className={`icon-xs ml-auto shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/tool-row:text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`}
            />
          </RowButton>
          {open ? (
            <div className="ml-3 max-h-[min(28rem,60vh)] overflow-y-auto border-l border-[color:var(--border-subtle)] pl-1.5">
              {settled.map(step)}
            </div>
          ) : null}
        </>
      ) : (
        settled.map(step)
      )}
      {running.map(step)}
    </>
  )
}
export function WorkTimelineStep({ tool }: { tool: TranscriptToolEntry }) {
  return tool.subagentLane ? <SubagentLane tool={tool} /> : <ToolRow tool={tool} />
}

// A background agent the model spawned: a lane header that stays live for the
// agent's real duration, over its own rail of the steps that ran inside it.
// Concurrent agents are sibling lanes in the parent rail, each counting its own
// time — the fan-out is the most differentiating thing on screen, so it is
// never flattened into one anonymous "Task" row.
export const MAX_VISIBLE_LANE_STEPS = 6

export function SubagentLane({ tool }: { tool: TranscriptToolEntry }) {
  const running = tool.status === 'running'
  const laneRef = useRef<HTMLDivElement>(null)
  useLiveRowMotion(laneRef, running)
  const context = useConversationLinkContext()
  // A live lane mounts open so its work is visible while it happens; a lane
  // replayed from history mounts collapsed and stays where the user leaves it.
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `lane:${tool.id}`,
    running,
  )
  const [showAllSteps, setShowAllSteps] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `lane-all:${tool.id}`,
    false,
  )
  const children = tool.children ?? []
  const hiddenSteps = showAllSteps ? 0 : Math.max(0, children.length - MAX_VISIBLE_LANE_STEPS)
  const visibleChildren = hiddenSteps > 0 ? children.slice(hiddenSteps) : children
  // What the model sent this agent to do; the lane's own steps are the rail
  // beneath it, so the header does not repeat their count.
  const object = toolObject(tool)
  const durationMs =
    tool.startedAt !== undefined && tool.completedAt !== undefined
      ? Math.max(0, tool.completedAt - tool.startedAt)
      : undefined
  // Steps only appear once the agent reports its first tool call, so a lane
  // with none yet is a plain row rather than an expander onto nothing.
  const expandable = children.length > 0
  const outcome = subagentOutcomeWord(tool)
  // The lane header's ink, split from the box: the pressable branch is a kit row
  // (which owns the box, the hover ground and the ring) and the readable twin
  // keeps the shape it always had.
  const headerInk = running ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-muted)]'
  const headerClass = `relative flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-meta ${headerInk}`
  const header = (
    <>
      <span
        className={`flex shrink-0 self-center ${toolGlyphInk(running ? 'running' : presentToolItem(toolPresentationInput(tool)).tone)}`}
      >
        <ToolKindGlyph kind="subagent" />
      </span>
      {expandable ? (
        <ChevronRightGlyph
          className={`icon-xs shrink-0 self-center text-[color:var(--text-subtle)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
      ) : null}
      {/* A lane at work reads as the live thing on screen; settled, it is one
          more step and sinks to the same quiet ink the tool rows rest in. */}
      <span
        className={`shrink-0 ${running ? 'font-medium text-[color:var(--text-default)]' : 'text-[color:var(--text-subtle)]'}`}
      >
        {subagentLaneLabel(tool)}
      </span>
      {object ? (
        <TruncatedText
          as="span"
          text={running ? `${object}…` : object}
          className="min-w-0 text-meta text-[color:var(--text-muted)]"
        />
      ) : null}
      <span className="ml-auto shrink-0 pl-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
        {running ? (
          tool.startedAt !== undefined ? (
            <LiveElapsed startedAt={tool.startedAt} />
          ) : (
            'running'
          )
        ) : (
          // How it ended when that was not plainly finishing, the model it was
          // asked to run on, and how long it took.
          [
            outcome ? (
              <span key="outcome" className={outcome === 'failed' ? 'text-[color:var(--tone-error)]' : undefined}>
                {outcome}
              </span>
            ) : null,
            subagentModel(tool),
            durationMs !== undefined ? formatStepDuration(durationMs) : null,
          ]
            .filter(Boolean)
            .flatMap((part, index) => (index ? [' · ', part] : [part]))
        )}
      </span>
      {running ? <span className="sr-only">running</span> : null}
    </>
  )
  return (
    <div ref={laneRef}>
      {expandable ? (
        <RowButton density="row" aria-expanded={open} onClick={() => setOpen(!open)} className={headerInk}>
          {header}
        </RowButton>
      ) : (
        <div className={headerClass}>{header}</div>
      )}
      {open && expandable ? (
        <div className="ml-2 mt-0.5 flex flex-col gap-0.5 border-l border-[color:var(--border-subtle)] pl-4">
          {hiddenSteps > 0 ? (
            <GhostButton
              size="inline"
              tone="subtle"
              align="start"
              onClick={() => setShowAllSteps(true)}
              className="self-start"
            >
              Show {hiddenSteps} earlier {hiddenSteps === 1 ? 'step' : 'steps'}
            </GhostButton>
          ) : null}
          {visibleChildren.map((child) => (
            <WorkTimelineStep key={child.id} tool={child} />
          ))}
        </div>
      ) : null}
      <SubagentLaneResult tool={tool} />
    </div>
  )
}

// A failed turn is a first-class transcript block: what happened in human
// words, the fix as a real action, raw provider detail folded away. Error tone
// appears on the 6px dot only — never as walls or borders.
export function TurnErrorBlock({
  entry,
  chrome,
}: {
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>
  chrome: TimelineChrome
}) {
  const [showDetails, setShowDetails] = useState(false)
  const detail = entry.failureDetail ?? entry.failureReason
  const authShaped = isAuthShapedFailure(`${entry.failureReason ?? ''} ${entry.failureDetail ?? ''}`)
  const message = authShaped
    ? 'The session could not authenticate — usually a sign your sign-in expired. Run `claude login` in a terminal, then retry. Your message is kept; retrying resumes the same conversation.'
    : 'Something went wrong while responding. Your message is kept; retrying resumes the same conversation.'
  return (
    <div className="mt-1 max-w-[68ch] rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-2 text-body font-semibold text-[color:var(--text-strong)]">
        <StatusDot tone="error" label="Turn failed" />
        {chrome.assistantName} couldn’t finish this turn
      </div>
      <p className="mb-2.5 mt-1 text-body leading-[1.55] text-[color:var(--text-muted)]">{message}</p>
      <div className="flex items-center gap-2">
        {chrome.retryTurnId === entry.turnId ? (
          <OutlineButton size="sm" onClick={chrome.onRetry} disabled={chrome.retryDisabled}>
            Retry
          </OutlineButton>
        ) : null}
        {detail ? (
          <LinkButton
            ink="quiet"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((value) => !value)}
            className="ml-auto"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </LinkButton>
        ) : null}
      </div>
      {showDetails && detail ? (
        <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)] px-3 py-2 font-mono text-micro leading-[1.6] text-[color:var(--text-subtle)]">
          {detail}
        </pre>
      ) : null}
    </div>
  )
}

// The turn's decision records, in the order they were answered. Spacing is the
// caller's (a turn block sits them above its prose; an orphan run stands alone).
export function ResolvedDecisions({ rows, className }: { rows: ConversationDecisionRow[]; className?: string }) {
  if (rows.length === 0) return null
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      {rows.map((row) =>
        row.kind === 'decision' ? (
          <ResolvedDecisionRow key={row.id} entry={row.entry} />
        ) : (
          <ResolvedDecisionGroupRow key={row.id} row={row} />
        ),
      )}
    </div>
  )
}

// A batch answered in one go is one line — the outcome and the count — over the
// same quote rail as a single decision, expandable to the individual requests.
export function ResolvedDecisionGroupRow({
  row,
}: {
  row: Extract<ConversationDecisionRow, { kind: 'decisionGroup' }>
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="max-w-[68ch] border-l-2 border-[color:var(--border-default)] py-0.5 pl-4">
      <GhostButton
        size="inline"
        tone="strong"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="text-body"
      >
        <ChevronRightGlyph
          className={`icon-xs text-[color:var(--text-subtle)] transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        {row.status === 'approved' ? (
          <CheckGlyph className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
        ) : row.status === 'denied' ? (
          <StatusDot tone="error" />
        ) : null}
        {row.label}
      </GhostButton>
      {expanded ? (
        <ul className="mt-1 flex flex-col gap-0.5 pl-1">
          {row.entries.map((entry) => {
            const object = toolObject({ name: entry.action ?? '', summary: entry.summary })
            return (
              <li key={entry.requestId} className="flex items-baseline gap-2 text-meta leading-5">
                {entry.action ? (
                  <span className="shrink-0 font-medium text-[color:var(--text-default)]">{entry.action}</span>
                ) : null}
                <TruncatedText
                  as="span"
                  text={object || entry.summary}
                  className="min-w-0 font-mono text-meta text-[color:var(--text-muted)]"
                />
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

// Resolved requests stay in the transcript as quote-style decision records —
// the question muted, the chosen answer strong with an accent check.
export function ResolvedDecisionRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'approval' }> }) {
  const answerLine = (text: string, good: boolean): React.ReactNode => (
    <div className="mt-0.5 flex items-center gap-1.5 text-body font-medium text-[color:var(--text-strong)]">
      {good ? (
        <CheckGlyph className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
      ) : (
        <StatusDot tone="error" label="Denied" />
      )}
      {text}
    </div>
  )
  return (
    <div className="max-w-[68ch] border-l-2 border-[color:var(--border-default)] py-0.5 pl-4">
      {entry.requestKind === 'question' && entry.questions?.length ? (
        <div className="space-y-2">
          {entry.questions.map((question) => {
            const answer = entry.answers?.[question.question]
            return (
              <div key={question.question}>
                <div className="text-meta leading-5 text-[color:var(--text-muted)]">{question.question}</div>
                {entry.status === 'approved' && answer ? (
                  answerLine(answer, true)
                ) : entry.status === 'denied' ? (
                  <div className="mt-0.5 text-meta italic text-[color:var(--text-subtle)]">
                    Dismissed without answering
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div>
          {entry.requestKind === 'plan' && entry.plan?.trim() ? (
            <ResolvedPlanCard requestId={entry.requestId} plan={entry.plan} />
          ) : (
            <div className="text-meta leading-5 text-[color:var(--text-muted)]">
              {entry.requestKind === 'plan' ? 'Proposed a plan' : entry.summary}
            </div>
          )}
          {entry.status === 'approved' ? (
            answerLine(
              entry.autoApproved
                ? `Auto-approved: ${entry.ruleLabel ?? 'matching permission rule'}`
                : entry.requestKind === 'plan'
                  ? 'Plan approved'
                  : 'Approved',
              true,
            )
          ) : entry.status === 'denied' ? (
            answerLine(entry.requestKind === 'plan' ? 'Sent back for more planning' : 'Denied', false)
          ) : (
            <div className="mt-0.5 text-meta italic text-[color:var(--text-subtle)]">Cancelled with the turn</div>
          )}
        </div>
      )}
    </div>
  )
}

// Live status line while a turn streams: the latest step verb shimmers quietly
// (plain muted text under prefers-reduced-motion).
export function WorkingTimelineRow({ row }: { row: Extract<ConversationTimelineRow, { kind: 'working' }> }) {
  const ref = useRef<HTMLDivElement>(null)
  useLiveRowMotion(ref, true)
  return (
    <div ref={ref} className="flex gap-2 pb-2 pl-0.5 text-meta text-[color:var(--text-muted)]">
      <span className="chat-shimmer font-medium">{row.label}</span>
      {row.startedAt !== undefined ? <LiveElapsed startedAt={row.startedAt} /> : null}
    </div>
  )
}

function MessageTimestamp({ at }: { at?: number }) {
  if (at === undefined || !Number.isFinite(at)) return null
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  // Muted clears AA at this size in every theme. Opacity reserves the same
  // slot before hover/focus, so revealing the timestamp cannot shift a row.
  return (
    <Tooltip content={date.toISOString()}>
      <span
        tabIndex={0}
        className="shrink-0 whitespace-nowrap text-micro tabular-nums text-[color:var(--text-muted)] opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
      >
        {formatMessageTime(at)}
      </span>
    </Tooltip>
  )
}

export function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.5L5 9l4.5-5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
