// The rows of the chat timeline: user turns, assistant turns, the work
// timeline with its subagent lanes, errors and resolved decisions.

import {
  type ConversationTimelineRow,
  type ConversationDecisionRow,
  flattenToolEntries,
  toolObject,
  subagentLaneLabel,
  toolVerb,
} from './conversationTimeline'
import { type TranscriptEntry, type TranscriptToolEntry } from './conversationProjection'
import { AttachmentThumbnail } from '../ComposerAttachmentStrip'
import { TruncatedText, GhostButton, StatusDot, RowButton, OutlineButton, LinkButton } from '../../ui'
import { ChatGlyph } from './modelPicker'
import { renderMarkdown } from '../../../utils/markdown'
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
  assistantName: string
  modelLabelFor: (modelId?: string) => string
  // Only the latest failed turn is retryable (retry re-sends the last message).
  retryTurnId?: string
  onRetry: () => void
  retryDisabled: boolean
}

export function TimelineRow({ row, chrome }: { row: ConversationTimelineRow; chrome: TimelineChrome }) {
  return (
    <div className="conversation-row-enter" data-conversation-row-kind={row.kind}>
      {row.kind === 'user' ? <UserTimelineRow entry={row.entry} /> : null}
      {row.kind === 'assistant' ? (
        <AssistantTurnBlock entry={row.entry} tools={row.tools} decisions={row.decisions} chrome={chrome} />
      ) : null}
      {row.kind === 'approval' ? <ResolvedDecisions rows={row.decisions} className="pb-6" /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
}

// User message: quiet right-aligned card, no chrome. Images sent with the turn
// sit above the text; an image-only turn renders no empty text line. Live-only
// (D3/1774) — a bubble restored from the replayed transcript has no images.
export function UserTimelineRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }) {
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
        {entry.text ? (
          <p className="whitespace-pre-wrap text-body leading-normal text-[color:var(--text-strong)]">{entry.text}</p>
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
          <span className="shrink-0 whitespace-nowrap text-micro tabular-nums text-[color:var(--text-muted)]">
            {formatClockTime(entry.startedAt)}
          </span>
        ) : null}
      </div>
      {entry.reasoning.trim() ? (
        <ThoughtRow reasoning={entry.reasoning} durationMs={entry.reasoningDurationMs} />
      ) : null}
      {tools.length > 0 ? <WorkTimeline tools={tools} live={entry.status === 'streaming'} /> : null}
      <ResolvedDecisions rows={decisions} className={entry.text.trim() ? 'mb-3' : undefined} />
      {entry.text.trim() ? <div className="max-w-[68ch]">{renderMarkdown(entry.text)}</div> : null}
      {entry.status === 'interrupted' ? (
        <span className="text-micro text-[color:var(--text-subtle)]">Interrupted</span>
      ) : null}
      {entry.status === 'failed' ? <TurnErrorBlock entry={entry} chrome={chrome} /> : null}
    </div>
  )
}

// "Thought for Ns" disclosure; expanded reasoning reads as a quiet aside.
export function ThoughtRow({ reasoning, durationMs }: { reasoning: string; durationMs?: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mb-1.5">
      <GhostButton size="inline" tone="subtle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
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

// The work timeline: a collapsible "Worked for <elapsed> · N steps" header over
// a hairline rail of verb-led steps. The live step carries the only pulsing
// accent dot on screen.
// Long turns can run hundreds of tools; the rail shows the most recent steps
// (the live tail is what matters) behind a "Show N earlier steps" expander so
// a big turn cannot flood the transcript with unbounded rows.
export const MAX_VISIBLE_WORK_STEPS = 12

export function WorkTimeline({ tools, live }: { tools: TranscriptToolEntry[]; live: boolean }) {
  const [open, setOpen] = useState(true)
  const [showAllSteps, setShowAllSteps] = useState(false)
  const hiddenSteps = showAllSteps ? 0 : Math.max(0, tools.length - MAX_VISIBLE_WORK_STEPS)
  const visibleTools = hiddenSteps > 0 ? tools.slice(hiddenSteps) : tools
  // Steps inside subagent lanes are real work: they count toward the header
  // total and keep the turn "working" while a background agent is still going.
  const allSteps = flattenToolEntries(tools)
  const first = tools[0]
  const lastDone = [...allSteps].reverse().find((tool) => tool.completedAt !== undefined)
  const elapsedMs =
    first?.startedAt !== undefined && lastDone?.completedAt !== undefined
      ? Math.max(0, lastDone.completedAt - first.startedAt)
      : undefined
  const working = live || allSteps.some((tool) => tool.status === 'running')
  return (
    <div className="mb-3">
      <GhostButton size="inline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRightGlyph
          className={`icon-xs text-[color:var(--text-subtle)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {working ? (
          <span className="inline-flex items-baseline gap-1 tabular-nums">
            Working
            {first?.startedAt !== undefined ? (
              <>
                &nbsp;·&nbsp;
                <LiveElapsed startedAt={first.startedAt} />
              </>
            ) : null}
          </span>
        ) : (
          <span className="tabular-nums">
            {elapsedMs !== undefined ? `Worked for ${formatStepDuration(elapsedMs)} · ` : ''}
            {allSteps.length} {allSteps.length === 1 ? 'step' : 'steps'}
          </span>
        )}
      </GhostButton>
      {open ? (
        <div className="ml-1.5 mt-1.5 flex flex-col gap-0.5 border-l border-[color:var(--border-default)] pl-4">
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
          {visibleTools.map((tool) => (
            <WorkTimelineStep key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// A spawned agent gets a lane; everything else is a plain step.
export function WorkTimelineStep({ tool }: { tool: TranscriptToolEntry }) {
  return tool.subagentLane ? <SubagentLane tool={tool} /> : <WorkStep tool={tool} />
}

// A background agent the model spawned: a lane header that stays live for the
// agent's real duration, over its own rail of the steps that ran inside it.
// Concurrent agents are sibling lanes in the parent rail, each counting its own
// time — the fan-out is the most differentiating thing on screen, so it is
// never flattened into one anonymous "Task" row.
export const MAX_VISIBLE_LANE_STEPS = 6

export function SubagentLane({ tool }: { tool: TranscriptToolEntry }) {
  const running = tool.status === 'running'
  // A live lane mounts open so its work is visible while it happens; a lane
  // replayed from history mounts collapsed and stays where the user leaves it.
  const [open, setOpen] = useState(running)
  const [showAllSteps, setShowAllSteps] = useState(false)
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
    <div>
      {expandable ? (
        <RowButton density="row" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={headerInk}>
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

export function WorkStep({ tool }: { tool: TranscriptToolEntry }) {
  const running = tool.status === 'running'
  const object = toolObject(tool)
  const durationMs =
    tool.startedAt !== undefined && tool.completedAt !== undefined
      ? Math.max(0, tool.completedAt - tool.startedAt)
      : undefined
  const showOutput = !running && tool.name === 'Bash' && Boolean(tool.output?.trim())
  return (
    <>
      <div
        className={`relative flex items-baseline gap-2 rounded-sm px-2 py-1 text-meta ${
          running ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-muted)]'
        }`}
      >
        <StatusDot tone={running ? 'accent' : 'neutral'} pulse={running} className="absolute -left-[19px] top-[10px]" />
        <span className="shrink-0 font-medium text-[color:var(--text-default)]">{toolVerb(tool.name, running)}</span>
        {object ? (
          <TruncatedText
            as="span"
            text={running ? `${object}…` : object}
            className="min-w-0 font-mono text-meta text-[color:var(--text-muted)]"
          />
        ) : null}
        {typeof tool.addedLines === 'number' && tool.addedLines > 0 ? (
          <span className="shrink-0 text-micro font-medium tabular-nums text-[color:var(--diff-added)]">
            +{tool.addedLines}
          </span>
        ) : null}
        {typeof tool.removedLines === 'number' && tool.removedLines > 0 ? (
          <span className="shrink-0 text-micro font-medium tabular-nums text-[color:var(--diff-removed)]">
            −{tool.removedLines}
          </span>
        ) : null}
        {!running && durationMs !== undefined ? (
          <span className="ml-auto shrink-0 pl-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
            {formatStepDuration(durationMs)}
          </span>
        ) : null}
        {running ? <span className="sr-only">running</span> : null}
      </div>
      {showOutput ? <StepOutput output={tool.output ?? ''} /> : null}
    </>
  )
}

// Command output in a terminal-toned block; ✓ lines read as passes. Collapsed
// past six lines so a long test run doesn't drown the timeline.
export const STEP_OUTPUT_COLLAPSED_LINES = 6

export function StepOutput({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = output.replace(/\n+$/, '').split('\n')
  const collapsed = !expanded && lines.length > STEP_OUTPUT_COLLAPSED_LINES
  const visible = collapsed ? lines.slice(0, STEP_OUTPUT_COLLAPSED_LINES) : lines
  return (
    <div className="mb-1.5 ml-2 mt-0.5 overflow-hidden rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)]">
      <pre className="overflow-x-auto px-3 py-2 font-mono text-meta leading-[1.6] text-[color:var(--terminal-fg)]">
        {/* Matches a tick the test runner already printed into its own output:
            agent-authored text this pane only tones, never a glyph the product
            draws. design-tokens-allow: matcher for agent-authored output */}
        {visible.map((line, index) => (
          <div key={index} className={/^\s*✓/.test(line) ? 'text-[color:var(--tone-good)]' : undefined}>
            {line || ' '}
          </div>
        ))}
      </pre>
      {lines.length > STEP_OUTPUT_COLLAPSED_LINES ? (
        // `bleed`: the row is full-bleed inside an `overflow-hidden` block, so
        // an outset ring would be clipped by it.
        <RowButton
          density="bleed"
          onClick={() => setExpanded((value) => !value)}
          className="border-t border-[color:var(--border-subtle)] text-micro"
        >
          {collapsed ? `Show ${lines.length - STEP_OUTPUT_COLLAPSED_LINES} more lines` : 'Show less'}
        </RowButton>
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
  return (
    <div className="pb-2 pl-0.5">
      <span className="chat-shimmer text-meta font-medium text-[color:var(--text-muted)]">{row.label}</span>
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
    update()
    const id = window.setInterval(update, 1000)
    return () => window.clearInterval(id)
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
