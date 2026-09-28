// A plan the agent proposed, kept in the transcript after it is answered. The
// dock shows the plan while it waits for a decision; once decided, this card is
// where it can still be read, so an approved plan does not vanish with its
// request. A long plan rests as a fading preview rather than a wall of text.

import React from 'react'
import { Badge, GhostButton } from '../../ui'
import { ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'
import { copyToClipboardWithToast } from '../../../utils/copyToClipboardWithToast'

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u

// Past this a plan rests collapsed: about a screenful of prose, or a list long
// enough that the answer under it would be pushed out of view.
export const PLAN_PREVIEW_MAX_LINES = 20
export const PLAN_PREVIEW_MAX_CHARS = 900

/** The plan's own name: its first heading, when it has one. */
export function planTitle(plan: string): string | null {
  for (const line of plan.split(/\r?\n/u)) {
    const match = HEADING.exec(line)
    if (match?.[1]) return match[1]
  }
  return null
}

/** The plan as the card shows it: a leading heading is already the card's title. */
export function planBody(plan: string): string {
  const lines = plan.trim().split(/\r?\n/u)
  if (lines[0] && HEADING.test(lines[0])) lines.shift()
  return lines.join('\n').trim()
}

export function planIsLong(plan: string): boolean {
  return plan.length > PLAN_PREVIEW_MAX_CHARS || plan.split(/\r?\n/u).length > PLAN_PREVIEW_MAX_LINES
}

export function ResolvedPlanCard({ requestId, plan }: { requestId: string; plan: string }) {
  const context = useConversationLinkContext()
  const [expanded, setExpanded] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `plan:${requestId}`,
    false,
  )
  const title = planTitle(plan) ?? 'Proposed plan'
  const body = planBody(plan)
  const long = planIsLong(body)
  const clamped = long && !expanded
  return (
    <div
      data-conversation-plan=""
      className="rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <Badge>Plan</Badge>
        <span className="min-w-0 truncate text-body font-medium text-[color:var(--text-strong)]">{title}</span>
        <GhostButton
          size="xs"
          className="ml-auto shrink-0"
          aria-label="Copy plan"
          onClick={() => void copyToClipboardWithToast(plan.trim())}
        >
          Copy
        </GhostButton>
      </div>
      {body ? (
        <div
          className={`min-w-0 px-3 pt-1 text-meta leading-5 ${
            clamped ? 'max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : ''
          }`}
        >
          <ConversationMarkdown text={body} />
        </div>
      ) : null}
      <div className="px-3 pb-2 pt-1">
        {long ? (
          <GhostButton size="inline" tone="subtle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : 'Show full plan'}
          </GhostButton>
        ) : null}
      </div>
    </div>
  )
}
