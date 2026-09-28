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
import {
  Badge,
  CopyGlyphButton,
  TruncatedText,
  GhostButton,
  IconButton,
  LifecycleGlyph,
  RowButton,
  OutlineButton,
  LinkButton,
  Tooltip,
} from '../../ui'
import { ConversationFileLink, ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import { stepWentWrong, ToolRow, toolGlyphInk, toolPresentationInput } from './toolRows/ToolRow'
import { useConversationDisclosure } from './conversationViewState'
import { UserMessageFold } from './userMessageFold'
import { presentToolItem, summarizeToolGroup } from '../../../../../shared/conversation/presentation'
import type { ConversationToolKind } from '../../../../../shared/conversation-runtime'
import { deriveTurnFold } from './turnFolds'
import { formatStepDuration } from './stepDuration'
import { useLiveRowMotion } from './liveVisibility'
import { formatMessageDateTime, formatMessageTime, LiveElapsed } from './liveElapsed'
import { ReasoningBlock } from './reasoningBlock'
import { CompactionDivider, TurnMeta } from './turnMeta'
import { CommandOutputRow } from './commandOutputRow'
import { ChevronRightGlyph, ToolKindGlyph } from './toolRows/ToolKindGlyph'
import { ChangedFilesCard, hasTurnChanges, RevertTurnAction } from './changedFilesCard'
import { EditFromHereAction, type EditFromHereDraft } from './editFromHere'
import { ResolvedPlanCard } from './planCard'
import { SubagentLaneResult, subagentModel } from './subagentResult'
import { AgentCardContent, LaneGlyph, laneOutcomeWords, laneTask, useOpenAgentsPane } from './subagentStatus'
import React, { useId, useState, useRef } from 'react'

// Auth-shaped turn failures get a sign-in action in the error block. Whole
// words and stems, so a path or message that merely contains "author" or a
// number with 401 in it is not read as a lapsed login.
export function isAuthShapedFailure(reason: string | undefined): boolean {
  return Boolean(
    reason && /authenticat|unauthori[sz]ed|\bauth\b|log ?in|oauth|credential|\b401\b|expired|api key/i.test(reason),
  )
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
  // Opens a terminal running the chat CLI's own sign-in. Absent where Studio
  // cannot run it: another machine's chat, or a provider that signs in with a
  // key rather than the CLI's login.
  onSignIn?: () => Promise<void>
  // `window.api.platform`: on Windows the chat's login is the native CLI's,
  // which is not the one inside WSL.
  platform?: string
  // The agent CLI the chat drives ('claude-code', 'codex', …), so a lapsed
  // login names that CLI's own sign-in command. Absent for a provider that is
  // not a CLI, which gets the command-free wording.
  cli?: string | null
}

// Each CLI's own sign-in, as its maker documents it: what someone types in a
// terminal to renew the login a chat turn failed on.
const CLI_SIGN_IN_COMMAND: Readonly<Record<string, string>> = {
  'claude-code': 'claude auth login',
  codex: 'codex login',
  cursor: 'agent login',
  opencode: 'opencode auth login',
  grok: 'grok login',
}

// A message's actions (copy, clock, revert) rest hidden so a read-through is
// text only. A pointer reveals them over the row, the keyboard reveals them as
// focus enters the row, and a touch screen, which has no hover to ask with,
// always shows them.
const MESSAGE_ACTION_REVEAL =
  'opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100 pointer-coarse:opacity-100'

export const TimelineRow = React.memo(function TimelineRow({
  row,
  chrome,
}: {
  row: ConversationTimelineRow
  chrome: TimelineChrome
}) {
  return (
    <div
      className="group/conversation"
      data-conversation-row-kind={row.kind}
      // A copied stretch of transcript is what was said: the messages. A
      // compaction marker, a decision record and the live status line are
      // the view's own furniture, so a selection across them skips them.
      data-copy-exclude={
        row.kind === 'user' || row.kind === 'assistant' || row.kind === 'commandOutput' ? undefined : ''
      }
    >
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
      {row.kind === 'commandOutput' ? <CommandOutputRow entry={row.entry} /> : null}
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
          <div data-copy-exclude="" className={`flex flex-wrap justify-end gap-1.5 ${entry.text ? 'mb-2' : ''}`}>
            {attachments.map((attachment) => (
              <AttachmentThumbnail key={attachment.id} attachment={attachment} className="h-16 w-16" />
            ))}
            {stored.map((attachment) => (
              <StoredAttachmentThumbnail key={attachment.ref} attachment={attachment} className="h-16 w-16" />
            ))}
          </div>
        ) : null}
        {entry.mentions?.length || entry.skills?.length ? (
          <div data-copy-exclude="" className="mb-2 flex flex-wrap justify-end gap-1.5" aria-label="Attached context">
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
      <div data-copy-exclude="" className="mt-1 flex items-center justify-end gap-2">
        <MessageTimestamp at={entry.createdAt} />
        {/* An image-only turn has no words to copy; a button that puts nothing
            on the clipboard and still says it did is worse than none. */}
        {entry.text.trim() ? (
          <CopyGlyphButton size="xs" label="Copy message" text={entry.text} className={MESSAGE_ACTION_REVEAL} />
        ) : null}
        {chrome?.checkpointsEnabled &&
        entry.seq &&
        chrome.checkpointSeqs?.has(entry.seq) &&
        (!entry.reverted || entry.undoRevertSeq !== undefined) ? (
          <RevertTurnAction
            turnSeq={entry.reverted ? (entry.undoRevertSeq ?? entry.seq) : entry.seq}
            reverted={entry.reverted}
            overwritesLaterWork={entry.undoOverwritesLaterWork}
            running={chrome.conversationRunning ?? false}
            className={MESSAGE_ACTION_REVEAL}
          />
        ) : null}
        {chrome?.rewindEnabled && chrome.onRestoreDraft ? (
          <EditFromHereAction
            entry={entry}
            running={chrome.conversationRunning ?? false}
            canRestoreFiles={Boolean(chrome.checkpointsEnabled && entry.seq && chrome.checkpointSeqs?.has(entry.seq))}
            onRestoreDraft={chrome.onRestoreDraft}
            className={MESSAGE_ACTION_REVEAL}
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

// The bubble reads at the reply's own text size, so the two sides of the
// conversation are one reading scale; what it keeps of its own is the strong
// ink, blocks closer together, headings no larger than the text around them,
// and no margin under the last block.
const USER_MESSAGE_PROSE =
  '[&_p]:mb-2 [&_p]:text-heading [&_p]:leading-[1.6] [&_p]:text-[color:var(--text-strong)] ' +
  '[&_ul]:mb-2 [&_ul]:space-y-0.5 [&_ul]:text-heading [&_ul]:leading-[1.6] [&_ul]:text-[color:var(--text-strong)] ' +
  '[&_ol]:mb-2 [&_ol]:space-y-0.5 [&_ol]:text-heading [&_ol]:leading-[1.6] [&_ol]:text-[color:var(--text-strong)] ' +
  '[&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-heading [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-heading ' +
  '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-heading [&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-heading ' +
  '[&_h5]:mb-1 [&_h5]:mt-3 [&_h5]:text-heading [&_h6]:mb-1 [&_h6]:mt-3 [&_h6]:text-heading ' +
  '[&_.markdown-rendered>:first-child]:mt-0 [&_.markdown-rendered>:last-child]:mb-0'

// The message as markdown, so a pasted fence is highlighted code and a list
// is a list, with every newline kept as typed. A long one folds to its first
// lines under a fade (userMessageFold); the disclosure is remembered per
// message.
function UserMessageBody({ id, text }: { id: string; text: string }) {
  const context = useConversationLinkContext()
  return (
    <UserMessageFold
      conversationKey={`${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`}
      id={id}
      measureKey={text}
      className={`min-w-0 text-heading text-[color:var(--text-strong)] ${USER_MESSAGE_PROSE}`}
    >
      <ConversationMarkdown text={text} userText />
    </UserMessageFold>
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
  const foldRegionId = useId()
  const proseRef = useRef<HTMLDivElement>(null)
  // The reply as it was written: the prose between steps and the final text,
  // in order. Reasoning, steps and decisions are how it got there, not what it
  // said, so they stay out.
  const reply = [...(entry.intermediateText?.map((part) => part.text) ?? []), entry.text]
    .filter((part) => part.trim())
    .join('\n\n')
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
          aria-controls={foldRegionId}
          aria-label={fold.failed ? `${fold.label}, ${fold.failed} failed` : undefined}
          onClick={() => setWorkOpen(!workOpen)}
          className="group/fold"
        >
          {fold.label}
          {fold.failed ? <span className="text-[color:var(--tone-error)]">· {fold.failed} failed</span> : null}
          {/* The same turn-to-open chevron every other disclosure in the
              transcript carries, so the fold reads as one before it is tried. */}
          <ChevronRightGlyph
            className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/fold:text-[color:var(--text-subtle)] ${workOpen ? 'rotate-90' : ''}`}
          />
        </GhostButton>
      ) : null}
      {/* What the fold opens and closes. A step still running stays in here
          while the fold is shut, so the region is always drawn. */}
      <div id={foldRegionId}>
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
            duration={
              entry.reasoningDurationMs !== undefined ? formatStepDuration(entry.reasoningDurationMs) : undefined
            }
            live={entry.status === 'streaming' && entry.reasoningLive === true}
            disclosureId={entry.turnId}
          />
        ) : null}
      </div>
      <ResolvedDecisions rows={decisions} className={entry.text.trim() ? 'mb-3' : undefined} />
      {entry.text.trim() ? (
        // The pane's full width, as the composer below it: the column's edges
        // are the list's own padding, so prose, code blocks and tool rows all
        // share them with the user's bubble.
        <div ref={proseRef} className="min-w-0">
          <ConversationMarkdown text={entry.text} streaming={entry.status === 'streaming'} />
        </div>
      ) : null}
      {entry.status === 'interrupted' ? (
        <span data-copy-exclude="" className="text-micro text-[color:var(--text-subtle)]">
          Interrupted
        </span>
      ) : null}
      {entry.status !== 'streaming' ? (
        // The meta line is the view's, not the reply's: a copied turn is its
        // words, never "42s · 10:15" trailing after them.
        <div data-copy-exclude="" className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
          {entry.durationMs !== undefined ? <span>{formatStepDuration(entry.durationMs)}</span> : null}
          <TurnMeta entry={entry} modelSwitched={modelSwitched} />
          <MessageTimestamp at={entry.startedAt} />
          {reply ? (
            <CopyGlyphButton
              size="xs"
              label="Copy reply"
              text={reply}
              // The rendered reply beside its markdown, so a paste into a rich
              // editor keeps the headings, lists and code. Only when the final
              // text is the whole reply: the prose between steps may be folded
              // out of the page, and a rich copy missing it would disagree with
              // the plain one.
              html={entry.intermediateText?.length ? undefined : () => replyHtml(proseRef.current)}
              className={MESSAGE_ACTION_REVEAL}
            />
          ) : null}
        </div>
      ) : null}
      {entry.status === 'failed' ? <TurnErrorBlock entry={entry} chrome={chrome} /> : null}
      {chrome.checkpointsEnabled &&
      entry.status !== 'streaming' &&
      hasTurnChanges(entry.checkpointAvailable, entry.checkpointSummary) &&
      entry.checkpointTurnSeq &&
      entry.checkpointSummary ? (
        <div data-copy-exclude="">
          <ChangedFilesCard
            turnSeq={entry.checkpointTurnSeq}
            summary={entry.checkpointSummary}
            running={chrome.conversationRunning ?? false}
            reverted={entry.reverted}
            undoTurnSeq={entry.undoRevertSeq}
            undoOverwritesLaterWork={entry.undoOverwritesLaterWork}
          />
        </div>
      ) : null}
    </div>
  )
}

// The reply's rendered HTML for the clipboard's rich flavour, read off the page
// at click time rather than rendered twice. The chrome inside the prose (a code
// block's header, a copy glyph, screen-reader-only words) is not what the agent
// wrote, so it goes; a file link drawn as a button keeps its words. Classes are
// the app's own and mean nothing to the editor the paste lands in.
export function replyHtml(prose: HTMLElement | null): string {
  if (!prose) return ''
  const clone = prose.cloneNode(true) as HTMLElement
  for (const node of clone.querySelectorAll('[data-copy-exclude], [aria-hidden="true"], .sr-only')) node.remove()
  for (const button of clone.querySelectorAll('button')) {
    const span = document.createElement('span')
    span.textContent = button.textContent
    button.replaceWith(span)
  }
  for (const node of clone.querySelectorAll('[class], [style]')) {
    node.removeAttribute('class')
    node.removeAttribute('style')
  }
  return `<meta charset="utf-8">${clone.innerHTML}`
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
// it. Opened, the rail is as tall as its steps: each step is one line, and what
// a step opens is bounded by its own panel, so a cap here only nested a second
// scroll inside the transcript's and cut steps off with nothing to say more
// were below.
//
// Steps are how the reply was reached, so the whole group is chrome to a copied
// transcript; a selection made inside one step's output is still the browser's
// to copy, as it is.
function WorkTimelineGroup({ tools }: { tools: TranscriptToolEntry[] }) {
  const context = useConversationLinkContext()
  const settled = tools.filter((tool) => tool.status !== 'running')
  const running = tools.filter((tool) => tool.status === 'running')
  const key = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  const [open, setOpen] = useConversationDisclosure(key, `group:${tools[0]?.id ?? ''}`, false)
  const step = (tool: TranscriptToolEntry) => <WorkTimelineStep key={tool.id} tool={tool} />
  const { kind, failed } = describeToolGroup(settled)
  const summary = summarizeToolGroup(settled.map(toolPresentationInput))
  const railId = useId()
  return (
    <div data-copy-exclude="">
      {settled.length > 1 ? (
        <>
          <RowButton
            density="row"
            className="group/tool-row text-meta"
            aria-expanded={open}
            // Named only while the rail is drawn: a closed group renders none.
            aria-controls={open ? railId : undefined}
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
            <div id={railId} className="ml-3 border-l border-[color:var(--border-subtle)] pl-1.5">
              {settled.map(step)}
            </div>
          ) : null}
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
  const object = laneTask(tool)
  // Steps only appear once the agent reports its first tool call, so a lane
  // with none yet is a plain row rather than an expander onto nothing.
  const expandable = children.length > 0
  // "Done in 1m 29s", "Failed after 9s": how it ended and how long it took.
  const outcome = laneOutcomeWords(tool)
  // The lane header's ink, split from the box: the pressable branch is a kit row
  // (which owns the box, the hover ground and the ring) and the readable twin
  // keeps the shape it always had.
  const headerInk = running ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-muted)]'
  const headerClass = `relative flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-meta ${headerInk}`
  const header = (
    <>
      {/* The agent itself: a character that works while it runs and whose
          face says how it ended. The words beside it say the same. */}
      <LaneGlyph tool={tool} className="self-center" />
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
          <span className="text-[color:var(--accent-primary)]">
            Working{tool.startedAt !== undefined ? ' · ' : ''}
            {tool.startedAt !== undefined ? <LiveElapsed startedAt={tool.startedAt} /> : null}
          </span>
        ) : (
          // How it ended and how long it took, then the model it was asked to
          // run on when it named one.
          [
            outcome ? (
              <span
                key="outcome"
                className={tool.outputStatus === 'error' ? 'text-[color:var(--tone-error)]' : undefined}
              >
                {outcome}
              </span>
            ) : null,
            subagentModel(tool),
          ]
            .filter(Boolean)
            .flatMap((part, index) => (index ? [' · ', part] : [part]))
        )}
      </span>
    </>
  )
  // Hovering or focusing the agent says who it is, how it is doing and what
  // kind of helper it is (design-system/components/agent-glyph).
  const card = <AgentCardContent tool={tool} running={running} />
  const openAgents = useOpenAgentsPane()
  return (
    <div ref={laneRef}>
      <div className="group/lane flex min-w-0 items-center">
        {expandable ? (
          <Tooltip content={card} multiline placement="bottom" wrapperClassName="block min-w-0 flex-1">
            <RowButton density="row" aria-expanded={open} onClick={() => setOpen(!open)} className={headerInk}>
              {header}
            </RowButton>
          </Tooltip>
        ) : (
          <Tooltip content={card} multiline placement="bottom" wrapperClassName="block min-w-0 flex-1">
            <div tabIndex={0} className={`${headerClass} focus-visible:focus-ring-inset`}>
              {header}
            </div>
          </Tooltip>
        )}
        {/* This agent's own thread, in the Agents tab beside the chat. */}
        {openAgents ? (
          <Tooltip content="Open in Agents">
            <IconButton
              size="xs"
              aria-label={`Open ${subagentLaneLabel(tool)} in Agents`}
              className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover/lane:opacity-100"
              onClick={() => openAgents(tool.id)}
            >
              <OpenInPaneGlyph />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
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
  const [signingIn, setSigningIn] = useState(false)
  const detail = entry.failureDetail ?? entry.failureReason
  const authShaped = isAuthShapedFailure(`${entry.failureReason ?? ''} ${entry.failureDetail ?? ''}`)
  const onSignIn = authShaped ? chrome.onSignIn : undefined
  const detailsId = useId()
  const kept = 'Your message is kept; retrying resumes the same conversation.'
  // Where Studio cannot open the sign-in itself, the copy names the command of
  // the CLI this chat drives, set as code so it reads as something to type.
  // A provider with no known command is told to sign in, not given another
  // CLI's command that would do nothing for it.
  const command = chrome.cli ? CLI_SIGN_IN_COMMAND[chrome.cli] : undefined
  const message: React.ReactNode = !authShaped ? (
    `Something went wrong while responding. ${kept}`
  ) : onSignIn ? (
    `The session could not authenticate — usually a sign your sign-in expired. Sign in, then retry.${
      chrome.platform === 'win32'
        ? ` This signs in ${chrome.assistantName} for Windows, which keeps its own sign-in apart from WSL’s.`
        : ''
    } ${kept}`
  ) : command ? (
    <>
      The session could not authenticate — usually a sign your sign-in expired. Run{' '}
      <code className="rounded-xs border border-[color:var(--border-subtle)] bg-[color:var(--bg-active)] px-[0.3em] py-[0.05em] font-mono text-[0.9em] text-[color:var(--text-strong)]">
        {command}
      </code>{' '}
      in a terminal, then retry. {kept}
    </>
  ) : (
    `The session could not authenticate — usually a sign your sign-in expired. Sign in to ${chrome.assistantName} in a terminal, then retry. ${kept}`
  )
  const signIn = () => {
    if (!onSignIn || signingIn) return
    setSigningIn(true)
    void onSignIn().finally(() => setSigningIn(false))
  }
  return (
    <div
      data-copy-exclude=""
      className="mt-1 max-w-[68ch] rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-4 py-3"
    >
      <div className="flex items-center gap-2 text-body font-semibold text-[color:var(--text-strong)]">
        <LifecycleGlyph state="failed" label="Turn failed" />
        {chrome.assistantName} couldn’t finish this turn
      </div>
      <p className="mb-2.5 mt-1 text-body leading-[1.55] text-[color:var(--text-muted)]">{message}</p>
      <div className="flex items-center gap-2">
        {onSignIn ? (
          <OutlineButton size="sm" onClick={signIn} disabled={signingIn}>
            Sign in
          </OutlineButton>
        ) : null}
        {chrome.retryTurnId === entry.turnId ? (
          <OutlineButton size="sm" onClick={chrome.onRetry} disabled={chrome.retryDisabled}>
            Retry
          </OutlineButton>
        ) : null}
        {detail ? (
          <LinkButton
            ink="quiet"
            aria-expanded={showDetails}
            aria-controls={showDetails ? detailsId : undefined}
            onClick={() => setShowDetails((value) => !value)}
            className="ml-auto"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </LinkButton>
        ) : null}
      </div>
      {showDetails && detail ? (
        // The provider's own words are what a bug report or a search needs,
        // so they copy whole in one press rather than by drag-selecting a
        // wrapped block.
        <div id={detailsId} className="relative mt-2.5">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)] py-2 pl-3 pr-8 font-mono text-micro leading-[1.6] text-[color:var(--text-subtle)]">
            {detail}
          </pre>
          {/* Placed by its own box: the glyph's wrapper is positioned relative. */}
          <div className="absolute right-1 top-1">
            <CopyGlyphButton size="xs" label="Copy error details" text={detail} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

// The turn's decision records, in the order they were answered. Spacing is the
// caller's (a turn block sits them above its prose; an orphan run stands alone).
export function ResolvedDecisions({ rows, className }: { rows: ConversationDecisionRow[]; className?: string }) {
  if (rows.length === 0) return null
  // How the turn got its answer, not what it said: out of a copied transcript,
  // as it is out of the reply's own copy.
  return (
    <div data-copy-exclude="" className={`flex flex-col gap-2 ${className ?? ''}`}>
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
          <CrossGlyph className="icon-xs shrink-0 text-[color:var(--tone-error)]" />
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
        <CrossGlyph className="icon-xs shrink-0 text-[color:var(--tone-error)]" label="Denied" />
      )}
      {text}
    </div>
  )
  // A plan card spans the conversation column like a reply does; the reading
  // measure is for the one-line records, and a plan held to it sat in the left
  // half of a wide chat.
  const measure = entry.requestKind === 'plan' && entry.plan?.trim() ? '' : 'max-w-[68ch] '
  return (
    <div className={`${measure}border-l-2 border-[color:var(--border-default)] py-0.5 pl-4`}>
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
            <ResolvedPlanCard plan={entry.plan} planFilePath={entry.planFilePath} />
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
  const openAgents = useOpenAgentsPane()
  return (
    <div ref={ref} className="flex items-baseline gap-2 pb-2 pl-0.5 text-meta text-[color:var(--text-muted)]">
      <span className="chat-shimmer font-medium">{row.label}</span>
      {row.startedAt !== undefined ? <LiveElapsed startedAt={row.startedAt} /> : null}
      {row.agents && openAgents ? (
        <LinkButton ink="quiet" onClick={() => openAgents(null)}>
          See agents
        </LinkButton>
      ) : null}
    </div>
  )
}

function MessageTimestamp({ at }: { at?: number }) {
  if (at === undefined || !Number.isFinite(at)) return null
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  // Muted clears AA at this size in every theme. Opacity reserves the same
  // slot before hover/focus, so revealing the timestamp cannot shift a row.
  // Not a tab stop of its own: it is read, not operated, and it shows as soon
  // as focus lands on anything in the message. The tooltip is the full local
  // date and time, the reading a person checking "when was this" wants; a
  // screen reader, which cannot hover, is read that full reading in place of
  // the short one as it passes the row.
  const full = formatMessageDateTime(at)
  return (
    <Tooltip content={full}>
      <time
        dateTime={date.toISOString()}
        className={`shrink-0 whitespace-nowrap text-micro tabular-nums text-[color:var(--text-muted)] ${MESSAGE_ACTION_REVEAL}`}
      >
        <span aria-hidden="true">{formatMessageTime(at)}</span>
        <span className="sr-only">{full}</span>
      </time>
    </Tooltip>
  )
}

// A window with its side pane drawn in: open this beside the chat.
function OpenInPaneGlyph() {
  return (
    <svg className="icon-xs" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1.5" y="2" width="9" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 2v8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

// The denied twin of CheckGlyph: an answer that was no, in the error ink.
export function CrossGlyph({ className, label }: { className?: string; label?: string }) {
  const a11y = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const)
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" {...a11y}>
      <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
