// The rows of the chat timeline: user turns, assistant turns, the work
// timeline with its subagent lanes, errors and resolved decisions.

import {
  type ConversationTimelineRow,
  type ConversationDecisionRow,
  flattenToolEntries,
  toolObject,
  subagentLaneLabel,
} from './conversationTimeline'
import { type TranscriptEntry, type TranscriptToolEntry } from './conversationProjection'
import { AttachmentThumbnail } from '../ComposerAttachmentStrip'
import { Badge, TruncatedText, GhostButton, StatusDot, RowButton, OutlineButton, LinkButton, Tooltip } from '../../ui'
import { ChatGlyph } from './modelPicker'
import {
  ConversationFileLink,
  ConversationMarkdown,
  conversationText,
  useConversationLinkContext,
} from './conversationLinks'
import { ToolRow, toolPresentationInput } from './toolRows/ToolRow'
import { useConversationDisclosure } from './conversationViewState'
import { summarizeToolGroup } from '../../../../../shared/conversation/presentation'
import { deriveTurnFold } from './turnFolds'
import { copyToClipboardWithToast } from '../../../utils/copyToClipboardWithToast'
import { observeLiveVisibility, useLiveRowMotion } from './liveVisibility'
import { ChangedFilesCard, hasTurnChanges, RevertTurnAction } from './changedFilesCard'
import React, { useState, useRef, useEffect } from 'react'

export function formatStepDuration(ms: number): string {
  if (ms < 950) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
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
  revertedAfterSeq?: number | null
  checkpointSeqs?: ReadonlySet<number>
  latestTurnId?: string
  assistantName: string
  modelLabelFor: (modelId?: string) => string
  // Only the latest failed turn is retryable (retry re-sends the last message).
  retryTurnId?: string
  onRetry: () => void
  retryDisabled: boolean
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
        <AssistantTurnBlock entry={row.entry} tools={row.tools} decisions={row.decisions} chrome={chrome} />
      ) : null}
      {row.kind === 'approval' ? <ResolvedDecisions rows={row.decisions} className="pb-6" /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
})

// User message: quiet right-aligned card, no chrome. Images sent with the turn
// sit above the text; an image-only turn renders no empty text line. Live-only
// (D3/1774) — a bubble restored from the replayed transcript has no images.
export function UserTimelineRow({
  entry,
  chrome,
}: {
  entry: Extract<TranscriptEntry, { kind: 'user' }>
  chrome?: TimelineChrome
}) {
  const attachments = entry.attachments ?? []
  return (
    <div className="flex justify-end pb-6">
      <div className="max-w-[76%] rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
        {attachments.length > 0 ? (
          <div className={`flex flex-wrap justify-end gap-1.5 ${entry.text ? 'mb-2' : ''}`}>
            {attachments.map((attachment) => (
              <AttachmentThumbnail key={attachment.id} attachment={attachment} className="h-16 w-16" />
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
                />
              ),
            )}
          </div>
        ) : null}
        {entry.text ? (
          <p className="whitespace-pre-wrap text-body leading-normal text-[color:var(--text-strong)]">
            {conversationText(entry.text)}
          </p>
        ) : null}
        <GhostButton
          size="inline"
          className="opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
          onClick={() => void copyToClipboardWithToast(entry.text)}
        >
          Copy
        </GhostButton>
        {chrome?.checkpointsEnabled && entry.seq && chrome.checkpointSeqs?.has(entry.seq) ? (
          <RevertTurnAction
            turnSeq={entry.reverted ? (chrome.revertedAfterSeq ?? entry.seq) : entry.seq}
            reverted={entry.reverted}
            running={chrome.conversationRunning ?? false}
            className="opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
          />
        ) : null}
      </div>
    </div>
  )
}

// One assistant turn: byline → thought disclosure → work timeline → decisions
// → prose. Glyph-led, no avatar bubble; the reading text gets real size, chrome
// stays small and quiet.
export function AssistantTurnBlock({
  entry,
  tools,
  decisions,
  chrome,
}: {
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>
  tools: Extract<TranscriptEntry, { kind: 'tool' }>[]
  decisions: ConversationDecisionRow[]
  chrome: TimelineChrome
}) {
  const modelLabel = chrome.modelLabelFor(entry.modelId)
  const context = useConversationLinkContext()
  const fold = deriveTurnFold(entry, tools, !chrome.latestTurnId || chrome.latestTurnId === entry.turnId)
  const [workOpen, setWorkOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `fold:${entry.turnId}`,
    !fold?.defaultFolded,
  )
  // The model is attribution, not a timestamp fragment, so it gets its own chip
  // instead of riding a `·`-joined meta string with the clock.
  const turnModelLabel = modelLabel && modelLabel !== chrome.assistantName ? modelLabel : null
  return (
    <div className="pb-6">
      {/* Centered, not baseline-aligned: the glyphs are boxes, and hanging them
          off the text baseline is what made the star read as jammed. The star
          stays neutral — the accent belongs to the live step dot and the send
          button, and one accent star per turn would drown both out. */}
      {/* Wraps rather than crushes: in a narrow panel the clock drops to a
          second line instead of every part ellipsing down to "C… meta-llama…". */}
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The name truncates too: on a non-harness provider `assistantName` IS
            the model label, which can be a long `vendor/model-id`. */}
        <span className="inline-flex min-w-0 items-center gap-1.5 text-meta font-semibold text-[color:var(--text-strong)]">
          <SparkleGlyph className="icon-xs shrink-0 text-[color:var(--text-muted)]" />
          <TruncatedText as="span" text={chrome.assistantName} className="max-w-[220px]" />
        </span>
        {turnModelLabel ? (
          // Mirrors the composer's locked `ModelPickerPill`: same glyph, same
          // muted label, no affordance — the model for a finished turn is fixed
          // exactly like the pill is once a conversation starts.
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-sm bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-meta text-[color:var(--text-muted)]">
            <ChatGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
            <TruncatedText as="span" text={turnModelLabel} className="max-w-[180px]" />
          </span>
        ) : null}
        {entry.startedAt ? (
          // `--text-muted`, not `--text-subtle`: at 11px the subtle token only
          // reaches ~4.1:1 on the dark chat surface (~3.9:1 on Conifer), short
          // of AA. Muted clears 4.5:1 in every theme.
          <Tooltip content={new Date(entry.startedAt).toISOString()}>
            <span
              tabIndex={0}
              className="shrink-0 whitespace-nowrap text-micro tabular-nums text-[color:var(--text-muted)] opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
            >
              {new Date(entry.startedAt).toDateString() === new Date().toDateString()
                ? formatClockTime(entry.startedAt)
                : new Date(entry.startedAt).toLocaleString()}
            </span>
          </Tooltip>
        ) : null}
      </div>
      {fold ? (
        <GhostButton size="inline" tone="subtle" aria-expanded={workOpen} onClick={() => setWorkOpen(!workOpen)}>
          {fold.label}
        </GhostButton>
      ) : null}
      {(!fold || workOpen) && entry.reasoning.trim() ? (
        <ThoughtRow reasoning={entry.reasoning} durationMs={entry.reasoningDurationMs} turnId={entry.turnId} />
      ) : null}
      {tools.length > 0 ? (
        <WorkTimeline
          tools={fold && !workOpen ? tools.filter((tool) => tool.status === 'running') : tools}
          live={entry.status === 'streaming'}
          intermediateText={fold && !workOpen ? undefined : entry.intermediateText}
        />
      ) : null}
      <ResolvedDecisions rows={decisions} className={entry.text.trim() ? 'mb-3' : undefined} />
      {entry.text.trim() ? (
        <div className="max-w-[68ch]">
          <ConversationMarkdown text={entry.text} streaming={entry.status === 'streaming'} />
        </div>
      ) : null}
      {entry.status === 'interrupted' ? (
        <span className="text-micro text-[color:var(--text-subtle)]">Interrupted</span>
      ) : null}
      {entry.status !== 'streaming' ? (
        <div className="flex items-center gap-2 text-meta text-[color:var(--sem-color-text-muted)]">
          {entry.durationMs !== undefined ? <span>{formatStepDuration(entry.durationMs)}</span> : null}
          {entry.costUsd !== undefined ? <span>${entry.costUsd.toFixed(4)}</span> : null}
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
          undoTurnSeq={chrome.revertedAfterSeq ?? undefined}
        />
      ) : null}
    </div>
  )
}

// "Thought for Ns" disclosure; expanded reasoning reads as a quiet aside.
export function ThoughtRow({
  reasoning,
  durationMs,
  turnId = 'thought',
}: {
  reasoning: string
  durationMs?: number
  turnId?: string
}) {
  const context = useConversationLinkContext()
  const [expanded, setExpanded] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `thought:${turnId}`,
    false,
  )
  return (
    <div className="mb-1.5">
      <GhostButton size="inline" tone="subtle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ChevronRightGlyph className={`icon-xs transition-transform ${expanded ? 'rotate-90' : ''}`} />
        {durationMs !== undefined ? `Thought for ${formatStepDuration(durationMs)}` : 'Thought'}
      </GhostButton>
      {expanded ? (
        <p className="mb-1 mt-1 max-w-[68ch] whitespace-pre-wrap pl-1 text-body italic leading-5 text-[color:var(--text-muted)]">
          {reasoning}
        </p>
      ) : null}
    </div>
  )
}

// Settled steps share a summary disclosure; live work stays outside it.
// Retained as a compatibility export for consumers measuring old transcript
// fixtures. The viewport now windows rows instead of hiding earlier work.
export const MAX_VISIBLE_WORK_STEPS = 12

export function WorkTimeline({
  tools,
  live,
  intermediateText,
}: {
  tools: TranscriptToolEntry[]
  live: boolean
  intermediateText?: { text: string; beforeToolUseId: string }[]
}) {
  const context = useConversationLinkContext()
  const settled = tools.filter((tool) => tool.status !== 'running')
  const running = tools.filter((tool) => tool.status === 'running')
  const key = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  const [open, setOpen] = useConversationDisclosure(key, `group:${tools[0]?.id ?? ''}`, true)
  const step = (tool: TranscriptToolEntry) => (
    <React.Fragment key={tool.id}>
      {intermediateText
        ?.filter((part) => part.beforeToolUseId === tool.id)
        .map((part, index) => (
          <div key={index} className="mb-2 max-w-[68ch]">
            <ConversationMarkdown text={part.text} />
          </div>
        ))}
      <WorkTimelineStep tool={tool} />
    </React.Fragment>
  )
  return (
    <div className="mb-2" aria-busy={live}>
      {settled.length > 1 ? (
        <>
          <GhostButton size="inline" tone="subtle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronRightGlyph className={`icon-xs ${open ? 'rotate-90' : ''}`} />
            {summarizeToolGroup(settled.map(toolPresentationInput))}
            <span> · {flattenToolEntries(settled).length} steps</span>
          </GhostButton>
          {open ? <div className="ml-2">{settled.map(step)}</div> : null}
        </>
      ) : (
        settled.map(step)
      )}
      {running.map(step)}
    </div>
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
  // The lane header's ink, split from the box: the pressable branch is a kit row
  // (which owns the box, the hover ground and the ring) and the readable twin
  // keeps the shape it always had.
  const headerInk = running ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-muted)]'
  const headerClass = `relative flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-meta ${headerInk}`
  const header = (
    <>
      <StatusDot tone={running ? 'accent' : 'neutral'} pulse={running} className="absolute -left-[19px] top-[10px]" />
      {expandable ? (
        <ChevronRightGlyph
          className={`icon-xs shrink-0 self-center text-[color:var(--text-subtle)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
      ) : null}
      <span className="shrink-0 font-medium text-[color:var(--text-default)]">{subagentLaneLabel(tool)}</span>
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
        ) : durationMs !== undefined ? (
          formatStepDuration(durationMs)
        ) : null}
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
          <div className="text-meta leading-5 text-[color:var(--text-muted)]">
            {entry.requestKind === 'plan' ? 'Proposed a plan' : entry.summary}
          </div>
          {entry.status === 'approved' ? (
            answerLine(entry.requestKind === 'plan' ? 'Plan approved' : 'Approved', true)
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

export function LiveElapsed({ startedAt }: { startedAt: number }) {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const initial = formatElapsedMs(Date.now() - startedAt)
  useEffect(() => {
    const update = () => {
      if (textRef.current) textRef.current.textContent = formatElapsedMs(Date.now() - startedAt)
    }
    const element = textRef.current
    if (!element) return
    let timer: number | undefined
    const stop = observeLiveVisibility(element, (visible) => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      if (visible) {
        update()
        timer = window.setInterval(update, 1000)
      }
    })
    return () => {
      stop()
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [startedAt])
  return <span ref={textRef}>{initial}</span>
}

export function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function SparkleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5l1.7 4.1 4.3.4-3.2 2.9.9 4.3L8 11l-3.7 2.2.9-4.3L2 6l4.3-.4L8 1.5z" fill="currentColor" />
    </svg>
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

export function ChevronRightGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
