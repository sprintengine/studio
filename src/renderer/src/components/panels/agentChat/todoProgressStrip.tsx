// The agent's checklist, a row of the composer tray while it works through it:
// the step it is on, how far along it is, and — opened — the whole list. The
// transcript still keeps each write as a step; this is the one place that says
// where the list stands now, so it never has to be scrolled back to.

import React, { useMemo } from 'react'
import { RowButton } from '../../ui'
import type { TranscriptEntry } from './conversationProjection'
import { useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'
import { ChevronRightGlyph, ToolKindGlyph } from './toolRows/ToolKindGlyph'
import { toolGlyphInk } from './toolRows/ToolRow'
import { deriveTodoProgress, type TodoStepStatus } from './todoProgress'

const SEGMENT_INK: Record<TodoStepStatus, string> = {
  completed: 'bg-[color:var(--text-subtle)]',
  in_progress: 'bg-[color:var(--tone-accent)]',
  pending: 'bg-[color:var(--border-default)]',
}

const STATUS_WORD: Record<TodoStepStatus, string> = {
  completed: 'Done',
  in_progress: 'In progress',
  pending: 'Pending',
}

// A step's mark in the opened list, on the tool glyphs' 16-grid: a check for
// done, a ring with its centre filled for the step in hand, an empty ring for
// what is still to come.
function TodoStepGlyph({ status }: { status: TodoStepStatus }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="icon-xs mt-0.5 shrink-0">
      {status === 'completed' ? (
        <path
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" />
          {status === 'in_progress' ? <circle cx="8" cy="8" r="2" fill="currentColor" /> : null}
        </>
      )}
    </svg>
  )
}

export function ConversationTodoStrip({
  entries,
  activeTurn,
}: {
  entries: readonly TranscriptEntry[]
  activeTurn: boolean
}) {
  const progress = useMemo(() => deriveTodoProgress(entries, activeTurn), [entries, activeTurn])
  const context = useConversationLinkContext()
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    'todo-strip',
    false,
  )
  if (!progress) return null
  const working = progress.live && progress.steps.some((step) => step.status === 'in_progress')
  return (
    // A row of the composer tray, which draws the surface around it.
    <div data-conversation-todo-strip="">
      <RowButton
        density="row"
        className="group/tool-row gap-2 text-meta"
        aria-expanded={open}
        aria-label={`Tasks: ${progress.completed} of ${progress.total} done. Current: ${progress.current}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`flex shrink-0 ${toolGlyphInk(working ? 'running' : 'neutral')}`}>
          <ToolKindGlyph kind="todo" />
        </span>
        <span className="min-w-0 truncate text-[color:var(--text-default)]">{progress.current}</span>
        <span className="ml-auto shrink-0 pl-2 text-micro tabular-nums text-[color:var(--text-subtle)]">
          {progress.completed} of {progress.total}
        </span>
        <span aria-hidden="true" className="flex w-16 shrink-0 gap-px">
          {progress.steps.map((step, index) => (
            <span key={index} className={`h-1 min-w-0 flex-1 rounded-full ${SEGMENT_INK[step.status]}`} />
          ))}
        </span>
        <ChevronRightGlyph
          className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/tool-row:text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`}
        />
      </RowButton>
      {open ? (
        <ul
          aria-label={`Task list, ${progress.completed} of ${progress.total} done`}
          className="flex max-h-48 flex-col gap-1 overflow-y-auto px-2 pb-2 pt-0.5 text-meta leading-5"
        >
          {progress.steps.map((step, index) => (
            <li
              key={index}
              className={`flex items-start gap-2 ${
                step.status === 'completed'
                  ? 'text-[color:var(--text-subtle)]'
                  : step.status === 'in_progress'
                    ? 'text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-muted)]'
              }`}
            >
              <span
                className={`flex shrink-0 ${step.status === 'in_progress' ? 'text-[color:var(--tone-accent)]' : ''}`}
              >
                <TodoStepGlyph status={step.status} />
              </span>
              <span className="sr-only">{STATUS_WORD[step.status]}: </span>
              <span className="min-w-0 break-words">{step.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
