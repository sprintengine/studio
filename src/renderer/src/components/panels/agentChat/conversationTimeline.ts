// The chat's timeline: which rows a projected conversation turns into, and
// how resolved approvals are grouped.

import { type TranscriptToolEntry, type TranscriptEntry } from './conversationProjection'

// Every call in a lane subtree, lane headers included, in start order.
export function flattenToolEntries(tools: TranscriptToolEntry[]): TranscriptToolEntry[] {
  const flat: TranscriptToolEntry[] = []
  for (const tool of tools) {
    flat.push(tool)
    if (tool.children?.length) flat.push(...flattenToolEntries(tool.children))
  }
  return flat
}

// A lane names the kind of agent that was spawned, or the generic noun when
// the call did not name one. What it was sent to do rides alongside as the
// row's object (`toolObject`), so a fan-out of four Explore agents stays four
// distinguishable rows rather than four identical ones.
export function subagentLaneLabel(tool: TranscriptToolEntry): string {
  const subagentType = tool.subagentType?.trim()
  return subagentType ? `${subagentType} agent` : 'Agent'
}

export function activeConversationStage(
  entries: TranscriptEntry[],
  activeTurn: boolean,
): 'idle' | 'thinking' | 'tool' | 'approval' | 'responding' {
  const latestPendingApproval = [...entries]
    .reverse()
    .find((entry) => entry.kind === 'approval' && entry.status === 'pending')
  if (latestPendingApproval) return 'approval'
  const latestRunningTool = [...entries].reverse().find((entry) => entry.kind === 'tool' && entry.status === 'running')
  if (latestRunningTool) return 'tool'
  if (!activeTurn) return 'idle'
  const latestAssistant = [...entries].reverse().find((entry) => entry.kind === 'assistant')
  if (latestAssistant?.kind === 'assistant' && latestAssistant.text.trim().length > 0) return 'responding'
  return 'thinking'
}

export type ConversationApprovalEntry = Extract<TranscriptEntry, { kind: 'approval' }>

// A resolved request stays in the transcript as a decision record. A batch of
// tool permissions answered together is one line ("Approved 10 files"), not ten
// rows; a question or plan decision carries its own content and always keeps a
// row of its own.
export type ConversationDecisionRow =
  | { kind: 'decision'; id: string; entry: ConversationApprovalEntry }
  | {
      kind: 'decisionGroup'
      id: string
      status: 'approved' | 'denied' | 'cancelled'
      label: string
      entries: ConversationApprovalEntry[]
    }

export type ConversationTimelineRow =
  | { kind: 'user'; id: string; entry: Extract<TranscriptEntry, { kind: 'user' }> }
  // One row per assistant turn: byline, reasoning disclosure, work timeline
  // (the turn's tools), the turn's resolved decisions, and prose all render as
  // a single block, per the approved mockup.
  | {
      kind: 'assistant'
      id: string
      entry: Extract<TranscriptEntry, { kind: 'assistant' }>
      tools: Extract<TranscriptEntry, { kind: 'tool' }>[]
      decisions: ConversationDecisionRow[]
    }
  // Requests that never named a turn; they surface on their own.
  | { kind: 'approval'; id: string; decisions: ConversationDecisionRow[] }
  | {
      kind: 'working'
      id: string
      stage: ReturnType<typeof activeConversationStage>
      label: string
      startedAt?: number
    }

// ── Presentation vocabulary (pure, unit-tested) ─────────────────────────────

// Step verbs: past tense for finished steps, continuous for the live one.
export const TOOL_VERBS: Record<string, { done: string; live: string }> = {
  Read: { done: 'Read', live: 'Reading' },
  Grep: { done: 'Searched', live: 'Searching' },
  Glob: { done: 'Searched', live: 'Searching' },
  WebSearch: { done: 'Searched', live: 'Searching' },
  Edit: { done: 'Edited', live: 'Editing' },
  MultiEdit: { done: 'Edited', live: 'Editing' },
  NotebookEdit: { done: 'Edited', live: 'Editing' },
  Write: { done: 'Wrote', live: 'Writing' },
  Bash: { done: 'Ran', live: 'Running' },
  WebFetch: { done: 'Fetched', live: 'Fetching' },
}

export function toolVerb(tool: string, live: boolean): string {
  const verbs = TOOL_VERBS[tool]
  if (verbs) return live ? verbs.live : verbs.done
  return live ? `Calling ${tool}` : `Called ${tool}`
}

// The step object is the provider summary minus its "Tool: " prefix — the verb
// already says which tool ran.
export function toolObject(tool: { name: string; summary?: string }): string {
  const summary = tool.summary ?? ''
  const prefix = `${tool.name}: `
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary
}

// Tools whose permission request is really about a file, so a batch of them
// counts files rather than the generic "tool uses".
export const FILE_APPROVAL_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export const DECISION_VERB: Record<'approved' | 'denied' | 'cancelled', string> = {
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
}

export function resolvedDecisionGroupLabel(
  status: 'approved' | 'denied' | 'cancelled',
  entries: ConversationApprovalEntry[],
): string {
  const count = entries.length
  const files = entries.every((entry) => entry.action !== undefined && FILE_APPROVAL_TOOLS.has(entry.action))
  const noun = files ? (count === 1 ? 'file' : 'files') : count === 1 ? 'tool use' : 'tool uses'
  return `${DECISION_VERB[status]} ${count} ${noun}`
}

// Fold a turn's requests into decision rows. Pending requests are the composer
// dock's, never the transcript's. A run of consecutive tool permissions sharing
// one outcome collapses into a single expandable summary; question and plan
// decisions record a real answer and stay individual rows, and a run of one is
// left as its own row because a group of one is not a list.
export function groupResolvedDecisions(approvals: ConversationApprovalEntry[]): ConversationDecisionRow[] {
  const rows: ConversationDecisionRow[] = []
  let run: ConversationApprovalEntry[] = []
  const flush = (): void => {
    const first = run[0]
    if (!first) return
    if (run.length === 1) {
      rows.push({ kind: 'decision', id: `approval:${first.requestId}`, entry: first })
      // A pending request never joins a run; the check is what narrows the
      // group's outcome to a resolved one.
    } else if (first.status !== 'pending') {
      rows.push({
        kind: 'decisionGroup',
        id: `approvals:${first.requestId}`,
        status: first.status,
        label: resolvedDecisionGroupLabel(first.status, run),
        entries: run,
      })
    }
    run = []
  }
  for (const approval of approvals) {
    if (approval.status === 'pending') continue
    if ((approval.requestKind ?? 'tool') !== 'tool') {
      flush()
      rows.push({ kind: 'decision', id: `approval:${approval.requestId}`, entry: approval })
      continue
    }
    if (run[0] && run[0].status !== approval.status) flush()
    run.push(approval)
  }
  flush()
  return rows
}

export function deriveConversationTimelineRows(
  entries: TranscriptEntry[],
  activeTurn: boolean,
): ConversationTimelineRow[] {
  const rows: ConversationTimelineRow[] = []
  const stage = activeConversationStage(entries, activeTurn)
  const latestAssistant = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant')
  const pendingApproval = [...entries]
    .reverse()
    .find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> =>
        entry.kind === 'approval' && entry.status === 'pending',
    )

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.kind === 'user') {
      rows.push({ kind: 'user', id: `user:${entry.id}`, entry })
      continue
    }
    if (entry.kind === 'assistant') {
      const tools: Extract<TranscriptEntry, { kind: 'tool' }>[] = []
      let cursor = index + 1
      while (cursor < entries.length) {
        const next = entries[cursor]
        if (!next || next.kind !== 'tool' || next.turnId !== entry.turnId) break
        tools.push(next)
        cursor += 1
      }
      // The turn's own requests follow its tools in the entry stream. They ride
      // the turn block (between the work timeline and the prose) rather than
      // trailing it, so a decision reads before the text that came after it.
      const approvals: ConversationApprovalEntry[] = []
      while (cursor < entries.length) {
        const next = entries[cursor]
        if (!next || next.kind !== 'approval' || next.turnId !== entry.turnId) break
        approvals.push(next)
        cursor += 1
      }
      const decisions = groupResolvedDecisions(approvals)
      if (
        entry.text.trim() ||
        entry.reasoning.trim() ||
        tools.length > 0 ||
        decisions.length > 0 ||
        entry.status === 'failed' ||
        entry.status === 'interrupted'
      ) {
        rows.push({ kind: 'assistant', id: `assistant:${entry.turnId}`, entry, tools, decisions })
      }
      index = cursor - 1
      continue
    }
    if (entry.kind === 'approval') {
      // Requests with no turn to hang off: take the whole consecutive run so
      // they group like any other batch.
      let cursor = index
      const orphans: ConversationApprovalEntry[] = []
      while (cursor < entries.length) {
        const next = entries[cursor]
        if (!next || next.kind !== 'approval') break
        orphans.push(next)
        cursor += 1
      }
      const decisions = groupResolvedDecisions(orphans)
      const first = decisions[0]
      if (first) rows.push({ kind: 'approval', id: `orphan:${first.id}`, decisions })
      index = cursor - 1
    }
  }

  if (stage !== 'idle' && !pendingApproval) {
    const runningTool = [...entries]
      .reverse()
      .find((entry): entry is TranscriptToolEntry => entry.kind === 'tool' && entry.status === 'running')
    // Fan-out is the headline: while background agents run, the live line
    // counts them instead of naming whichever tool happened to start last.
    const runningLanes = entries.filter(
      (entry): entry is TranscriptToolEntry =>
        entry.kind === 'tool' && entry.status === 'running' && entry.subagentLane === true,
    )
    const laneLabel =
      runningLanes.length > 1
        ? `${runningLanes.length} agents working…`
        : runningLanes[0]
          ? `${subagentLaneLabel(runningLanes[0])} working…`
          : undefined
    const label =
      stage === 'tool' && laneLabel
        ? laneLabel
        : stage === 'tool' && runningTool
          ? `${toolVerb(runningTool.name, true)}${toolObject(runningTool) ? ` ${toolObject(runningTool)}` : ''}…`
          : stage === 'responding'
            ? 'Replying…'
            : 'Thinking…'
    rows.push({
      kind: 'working',
      id: 'working-indicator-row',
      stage,
      label,
      startedAt: latestAssistant?.startedAt,
    })
  }

  return rows
}
