// The dock above the composer that holds what the agent is waiting on:
// permission requests, plans to approve and questions to answer.

import React, { useRef, useEffect, useState } from 'react'
import {
  StatusDot,
  GhostButton,
  OutlineButton,
  MenuOption,
  Input,
  IconButton,
  SplitButton,
  InlineNotice,
} from '../../ui'
import { type TranscriptEntry } from './conversationProjection'
import { toolObject } from './conversationTimeline'
import { ConversationFileLink, ConversationMarkdown } from './conversationLinks'
import { InlineDiff } from '../../ui/InlineDiff'
import { deriveEditHunks } from '../../../../../shared/conversation/editHunks'
import { asRecord } from '../../../../../shared/records'
import { useConversationTransport } from './conversationTransport'
import type { ConversationQuestion } from '../../../../../shared/conversation-runtime'
import {
  approvalFilePath,
  approvalRememberLabels,
  approvalRuleCandidate,
  isPathWithinApprovalRoot,
  type ConversationApprovalDecision,
} from '../../../../../shared/conversation/approvalRules'

type ApprovalEntry = Extract<TranscriptEntry, { kind: 'approval' }>
type ApprovalHandler = (
  requestId: string,
  approved: boolean,
  answers?: Record<string, string>,
  decision?: ConversationApprovalDecision,
) => void

export function orderedPendingRequests(entries: readonly ApprovalEntry[]): ApprovalEntry[] {
  const order = { tool: 0, question: 1, plan: 2 }
  return entries
    .filter((entry) => entry.status === 'pending')
    .sort((a, b) => order[a.requestKind ?? 'tool'] - order[b.requestKind ?? 'tool'])
}

export function approvalOutsideWorkspace(entry: ApprovalEntry, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return false
  if (entry.cwd && !isPathWithinApprovalRoot(entry.cwd.replaceAll('\\', '/'), workspaceRoot)) return true
  const path = approvalFilePath({ action: entry.action ?? '', input: entry.input }, entry.cwd ?? workspaceRoot)
  if (path && !isPathWithinApprovalRoot(path, workspaceRoot)) return true
  const check = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(check)
    if (value && typeof value === 'object') return Object.values(value).some(check)
    if (typeof value !== 'string') return false
    return value.split(/[\s'";|]+/u).some((token) => {
      if (!/^(?:\/|[A-Za-z]:[\\/]|\.\.\/)/u.test(token)) return false
      const candidate = approvalFilePath(
        { action: entry.action ?? '', input: { path: token } },
        entry.cwd ?? workspaceRoot,
      )
      return Boolean(candidate && !isPathWithinApprovalRoot(candidate, workspaceRoot))
    })
  }
  return check(entry.input)
}

// The CLI convention marks a suggested answer with a "(Recommended)" suffix in
// the option label; render it as a quiet accent label instead of literal text.
// Answers are still submitted with the original label so the tool round-trips.
export function parseOptionLabel(label: string): { text: string; recommended: boolean } {
  const match = label.match(/^(.*?)\s*\(recommended\)\s*$/i)
  return match?.[1] ? { text: match[1], recommended: true } : { text: label, recommended: false }
}

// The shared card shell docked above the composer: eyebrow row with an earned
// status dot, content, then a footer of keyboard hints + actions. Question,
// permission and plan requests all render inside it so pending asks read as
// one consistent surface.
export function DockShell({
  dotTone,
  eyebrow,
  hints,
  actions,
  onKeyDown,
  containerRef,
  ariaLabel,
  children,
}: {
  dotTone: 'warn' | 'error' | 'accent'
  eyebrow: string
  hints?: React.ReactNode
  /**
   * The dock's buttons, in reading order with the affirmative one last. A dock
   * offers a two-button choice, and the two are never the same button twice:
   * the composer's Send holds this view's one `PrimaryButton` (audit ruling 9),
   * so the affirmative here is the `OutlineButton` — the spec's "ghost reads
   * too weak to be found, but this is not the view's primary" — and its
   * counterpart drops a step to `GhostButton`. One rung of the button ramp
   * apart, no second accent fill: the emphasis comes from the difference, which
   * is what two identical neutrals could never carry.
   */
  actions: React.ReactNode
  onKeyDown?: (event: React.KeyboardEvent) => void
  containerRef?: React.Ref<HTMLDivElement>
  ariaLabel: string
  children: React.ReactNode
}) {
  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="mb-2 max-h-[60vh] overflow-y-auto rounded-lg border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] outline-none"
    >
      <div className="flex items-center gap-2 px-4 pt-2.5">
        {/* Decorative: the eyebrow beside it is the same string, so a labelled
            dot would announce the state twice. */}
        <StatusDot tone={dotTone} />
        <span className="text-micro font-medium tracking-normal text-[color:var(--text-subtle)]">{eyebrow}</span>
      </div>
      {children}
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-2">
        {hints ? (
          <span className="flex items-center gap-2 text-micro text-[color:var(--text-subtle)]">{hints}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 gap-2">{actions}</div>
      </div>
    </div>
  )
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-xs border border-b-2 border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-1 py-px font-sans text-micro font-medium leading-none text-[color:var(--text-muted)]">
      {children}
    </kbd>
  )
}

// Humanize the tool behind a permission request for the eyebrow.
export function permissionActionLabel(action?: string): string {
  switch (action) {
    case 'Bash':
      return 'Run command'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Edit file'
    case 'Write':
      return 'Write file'
    case 'Read':
      return 'Read file'
    case 'WebFetch':
      return 'Fetch URL'
    case 'WebSearch':
      return 'Web search'
    default:
      return action ?? 'Tool request'
  }
}

export function ConversationPendingDock({
  pendingApproval,
  pendingApprovals,
  workspaceName,
  workspaceRoot,
  onApprove,
  busy,
}: {
  pendingApproval?: ApprovalEntry
  pendingApprovals?: ApprovalEntry[]
  workspaceName?: string
  workspaceRoot?: string
  onApprove: ApprovalHandler
  busy: boolean
}) {
  const entries = orderedPendingRequests(pendingApprovals ?? (pendingApproval ? [pendingApproval] : []))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.requestId === selectedId),
  )
  const navigate = (delta: number) =>
    setSelectedId(entries[(selectedIndex + delta + entries.length) % entries.length]?.requestId ?? null)
  if (!entries.length) return null
  return (
    <div
      onKeyDownCapture={(event) => {
        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        navigate(event.key === 'ArrowLeft' ? -1 : 1)
      }}
    >
      {entries.length > 1 ? (
        <div className="flex items-center justify-end gap-2 pb-1" aria-label="Pending requests">
          <IconButton aria-label="Previous request" onClick={() => navigate(-1)}>
            ←
          </IconButton>
          <span className="text-meta tabular-nums" role="status">
            {selectedIndex + 1}/{entries.length}
          </span>
          <IconButton aria-label="Next request" onClick={() => navigate(1)}>
            →
          </IconButton>
        </div>
      ) : null}
      {entries.map((entry, index) => (
        <div key={entry.requestId} hidden={index !== selectedIndex}>
          {entry.requestKind === 'question' && entry.questions?.length ? (
            <ConversationQuestionCard
              requestId={entry.requestId}
              questions={entry.questions}
              onAnswer={onApprove}
              busy={busy}
              active={index === selectedIndex}
            />
          ) : entry.requestKind === 'plan' ? (
            <ConversationPlanCard entry={entry} onApprove={onApprove} busy={busy} active={index === selectedIndex} />
          ) : (
            <ConversationPermissionCard
              entry={entry}
              workspaceName={workspaceName}
              workspaceRoot={workspaceRoot}
              onApprove={onApprove}
              busy={busy}
              active={index === selectedIndex}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// Permission request: lead with WHAT (the literal command in a terminal block
// for Bash, the summary otherwise) and WHERE (the workspace), not tool jargon.
// Enter approves, Escape denies.
export function ConversationPermissionCard({
  entry,
  workspaceName,
  workspaceRoot,
  onApprove,
  busy,
  active = true,
}: {
  entry: Extract<TranscriptEntry, { kind: 'approval' }>
  workspaceName?: string
  workspaceRoot?: string
  onApprove: ApprovalHandler
  busy: boolean
  active?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const denyRef = useRef<HTMLButtonElement | null>(null)
  const { permanentApprovals } = useConversationTransport().capabilities
  useEffect(() => {
    if (active) (entry.defaultToNo ? denyRef.current : containerRef.current)?.focus()
  }, [active, entry.defaultToNo])
  const rememberable = workspaceRoot
    ? approvalRuleCandidate(
        {
          action: entry.action ?? '',
          input: entry.input,
          requestKind: entry.requestKind,
          defaultToNo: entry.defaultToNo,
          suppressAlwaysAllowRule: entry.suppressAlwaysAllowRule,
        },
        workspaceRoot,
      )
    : null
  // The menu names exactly what a remembered rule grants ("git status …"),
  // not a generic "allow", since the rule outlives this one request.
  const rememberLabels = rememberable ? approvalRememberLabels(rememberable) : null
  const literalCommand = asRecord(entry.input)?.command
  const command =
    typeof literalCommand === 'string'
      ? literalCommand
      : entry.action === 'Bash'
        ? toolObject({ name: 'Bash', summary: entry.summary })
        : ''
  const edits = React.useMemo(() => deriveEditHunks(entry.input), [entry.input])
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (busy || event.defaultPrevented || event.nativeEvent.isComposing) return
    // Buttons own Enter themselves; the card shortcut is only for its empty
    // focus target, so Deny or a menu trigger can never bubble into approval.
    if (event.key === 'Enter' && event.target !== event.currentTarget) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onApprove(entry.requestId, !entry.defaultToNo, undefined, entry.defaultToNo ? 'deny' : 'once')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onApprove(entry.requestId, false, undefined, 'deny')
    }
  }
  return (
    <DockShell
      dotTone="warn"
      eyebrow={`Permission · ${permissionActionLabel(entry.action)}`}
      containerRef={containerRef}
      onKeyDown={handleKeyDown}
      ariaLabel="Permission request"
      hints={
        <>
          <span className="inline-flex items-center gap-1">
            <Kbd>⏎</Kbd> {entry.defaultToNo ? 'deny' : 'allow once'}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>⎋</Kbd> deny
          </span>
        </>
      }
      actions={
        <>
          <GhostButton
            ref={denyRef}
            onClick={() => onApprove(entry.requestId, false, undefined, 'deny')}
            disabled={busy}
          >
            Deny
          </GhostButton>
          {rememberLabels ? (
            <SplitButton
              label="Allow once"
              primaryAriaLabel="Allow once"
              menuAriaLabel="Remember permission"
              menuKind="alternatives"
              onPrimary={() => onApprove(entry.requestId, true, undefined, 'once')}
              disabled={busy}
              items={[
                {
                  id: 'conversation',
                  label: rememberLabels.conversation,
                  onSelect: () => onApprove(entry.requestId, true, undefined, 'conversation'),
                },
                // A rule that outlives the conversation is this machine's
                // decision; a transport that cannot make it does not offer it.
                ...(permanentApprovals
                  ? [
                      {
                        id: 'always',
                        label: rememberLabels.always,
                        onSelect: () => onApprove(entry.requestId, true, undefined, 'always'),
                      },
                    ]
                  : []),
              ]}
            />
          ) : (
            <OutlineButton
              size="sm"
              onClick={() => onApprove(entry.requestId, true, undefined, 'once')}
              disabled={busy}
            >
              Allow once
            </OutlineButton>
          )}
        </>
      }
    >
      {entry.originAgentId ? (
        <InlineNotice tone="warn" className="mx-4 mt-2">
          Requested by subagent {entry.originAgentId}.
        </InlineNotice>
      ) : null}
      {approvalOutsideWorkspace(entry, workspaceRoot) ? (
        <InlineNotice tone="warn" className="mx-4 mt-2">
          This request references a path outside this workspace.
        </InlineNotice>
      ) : null}
      {command ? (
        <div className="mx-4 mt-2 overflow-x-auto rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)] px-3 py-2.5 font-mono text-meta text-[color:var(--terminal-fg)]">
          <span className="select-none text-[color:var(--accent-primary)]">$ </span>
          {command}
        </div>
      ) : (
        <p className="px-4 pt-1.5 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
          {entry.summary}
        </p>
      )}
      {edits.map((edit, index) => (
        <div key={`${index}:${edit.path}`} className="mx-4 mt-2">
          <ConversationFileLink token={edit.path} source="inlineCode" />
          <InlineDiff edit={edit} />
        </div>
      ))}
      {workspaceName ? (
        <div className="flex items-center gap-1.5 px-4 pt-1.5 text-meta text-[color:var(--text-subtle)]">
          <FolderGlyph className="icon-xs" />
          in {workspaceName}
        </div>
      ) : null}
    </DockShell>
  )
}

export function ConversationPlanCard({
  entry,
  onApprove,
  busy,
  active = true,
}: {
  entry: Extract<TranscriptEntry, { kind: 'approval' }>
  onApprove: (requestId: string, approved: boolean, answers?: Record<string, string>) => void
  busy: boolean
  active?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (active) containerRef.current?.focus()
  }, [active])
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (busy || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && event.target !== event.currentTarget) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onApprove(entry.requestId, true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onApprove(entry.requestId, false)
    }
  }
  return (
    <DockShell
      dotTone="warn"
      eyebrow="Plan · Review & approve"
      containerRef={containerRef}
      onKeyDown={handleKeyDown}
      ariaLabel="Plan approval"
      hints={
        <>
          <span className="inline-flex items-center gap-1">
            <Kbd>⏎</Kbd> approve
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>⎋</Kbd> keep planning
          </span>
        </>
      }
      actions={
        <>
          <GhostButton onClick={() => onApprove(entry.requestId, false)} disabled={busy}>
            Keep planning
          </GhostButton>
          <OutlineButton size="sm" onClick={() => onApprove(entry.requestId, true)} disabled={busy}>
            Approve plan <Kbd>⏎</Kbd>
          </OutlineButton>
        </>
      }
    >
      {entry.plan?.trim() ? (
        <div className="mx-4 mt-2 max-h-64 overflow-y-auto rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] px-3 py-2.5 text-meta leading-5">
          <ConversationMarkdown text={entry.plan} />
        </div>
      ) : (
        <p className="px-4 pt-1.5 text-body leading-5 text-[color:var(--text-default)]">{entry.summary}</p>
      )}
    </DockShell>
  )
}

// Structured question card, one question at a time ("1 of N" when the model
// bundles several). Keyboard-first: 1–9 pick options, ↑↓ move, ⏎ advances or
// submits, ⎋ dismisses. Answers submit with the ORIGINAL option labels so the
// tool call round-trips; only the display strips "(Recommended)".
export function ConversationQuestionCard({
  requestId,
  questions,
  onAnswer,
  busy,
  active = true,
}: {
  requestId: string
  questions: ConversationQuestion[]
  onAnswer: (requestId: string, approved: boolean, answers?: Record<string, string>) => void
  busy: boolean
  active?: boolean
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (active) containerRef.current?.focus()
  }, [active, stepIndex])

  const question = questions[Math.min(stepIndex, questions.length - 1)]
  if (!question) return null
  const picks = selected[question.question] ?? []
  const isLast = stepIndex >= questions.length - 1

  const answerFor = (target: ConversationQuestion): string => {
    const targetPicks = selected[target.question] ?? []
    const other = otherText[target.question]?.trim()
    return [...targetPicks, ...(other ? [other] : [])].join(', ')
  }
  const currentAnswered = answerFor(question).length > 0

  const toggleOption = (label: string): void => {
    setSelected((current) => {
      const currentPicks = current[question.question] ?? []
      if (question.multiSelect) {
        const next = currentPicks.includes(label)
          ? currentPicks.filter((value) => value !== label)
          : [...currentPicks, label]
        return { ...current, [question.question]: next }
      }
      return { ...current, [question.question]: currentPicks.includes(label) ? [] : [label] }
    })
  }

  const moveSelection = (delta: number): void => {
    if (question.multiSelect || question.options.length === 0) return
    setSelected((current) => {
      const currentPicks = current[question.question] ?? []
      const labels = question.options.map((option) => option.label)
      const index = currentPicks[0] ? labels.indexOf(currentPicks[0]) : -1
      const next = labels[(index + delta + labels.length) % labels.length]
      return next ? { ...current, [question.question]: [next] } : current
    })
  }

  const advance = (): void => {
    if (!currentAnswered || busy) return
    if (!isLast) {
      setStepIndex((index) => index + 1)
      return
    }
    const answers: Record<string, string> = {}
    for (const target of questions) answers[target.question] = answerFor(target)
    onAnswer(requestId, true, answers)
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (busy || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && event.target !== event.currentTarget) return
    if (event.key >= '1' && event.key <= '9') {
      const option = question.options[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        toggleOption(option.label)
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      moveSelection(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      advance()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onAnswer(requestId, false)
    }
  }

  const eyebrow = `Question${question.header ? ` · ${question.header}` : ''} · ${stepIndex + 1} of ${questions.length}`
  return (
    <DockShell
      dotTone="warn"
      eyebrow={eyebrow}
      containerRef={containerRef}
      onKeyDown={handleKeyDown}
      ariaLabel="Question from the agent"
      hints={
        <>
          {!question.multiSelect && question.options.length > 1 ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>↑↓</Kbd> choose
            </span>
          ) : null}
          {question.options.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>1–{Math.min(question.options.length, 9)}</Kbd> {question.multiSelect ? 'toggle' : 'pick'}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Kbd>⏎</Kbd> {isLast ? 'answer' : 'next'}
          </span>
        </>
      }
      actions={
        <>
          <GhostButton onClick={() => onAnswer(requestId, false)} disabled={busy}>
            Dismiss
          </GhostButton>
          <OutlineButton size="sm" onClick={advance} disabled={busy || !currentAnswered}>
            {isLast ? 'Answer' : 'Next'} <Kbd>⏎</Kbd>
          </OutlineButton>
        </>
      }
    >
      <p className="px-4 pt-1.5 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
        {question.question}
      </p>
      <div
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.header ?? question.question}
        className="flex flex-col px-2 pt-1"
      >
        {question.options.map((option, index) => {
          const checked = picks.includes(option.label)
          const parsed = parseOptionLabel(option.label)
          return (
            // `role="checkbox"` is not one of the value-row roles, and inside a
            // `group` a multi-select answer is a `menuitemcheckbox`; the single
            // answer stays a `radio` in its radiogroup. Both take `aria-checked`,
            // which is what the primitive emits for either.
            <MenuOption
              key={option.label}
              role={question.multiSelect ? 'menuitemcheckbox' : 'radio'}
              stacked
              selected={checked}
              disabled={busy}
              onClick={() => toggleOption(option.label)}
              icon={
                index < 9 ? (
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 shrink-0 rounded-xs border px-1 py-px font-mono text-micro font-medium leading-none ${
                      checked
                        ? 'border-[color:var(--accent-primary)] text-[color:var(--accent-primary)]'
                        : 'border-[color:var(--border-strong)] text-[color:var(--text-subtle)]'
                    }`}
                  >
                    {index + 1}
                  </span>
                ) : null
              }
            >
              <span className="block text-body font-semibold leading-5 text-[color:var(--text-strong)]">
                {parsed.text}
                {parsed.recommended ? (
                  <span className="ml-2 text-micro font-medium tracking-normal text-[color:var(--text-muted)]">
                    Recommended
                  </span>
                ) : null}
              </span>
              {option.description ? (
                <span className="block text-meta leading-[1.45] text-[color:var(--text-muted)]">
                  {option.description}
                </span>
              ) : null}
            </MenuOption>
          )
        })}
      </div>
      {question.allowFreeText !== false ? (
        <div className="px-5 pb-1 pt-1.5">
          <Input
            variant="quiet"
            size="content"
            value={otherText[question.question] ?? ''}
            onChange={(event) => setOtherText((current) => ({ ...current, [question.question]: event.target.value }))}
            onKeyDown={(event) => {
              // The card's container hotkeys (digits pick options, arrows move)
              // must not fire while typing a free-text answer.
              event.stopPropagation()
              if (busy || event.defaultPrevented || event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                advance()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onAnswer(requestId, false)
              }
            }}
            placeholder="Something else…"
            disabled={busy}
            aria-label={`Other answer for: ${question.question}`}
          />
        </div>
      ) : null}
    </DockShell>
  )
}

export function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 013.5 3h2l1 1.5h4A1.5 1.5 0 0112 6v4a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 012 10V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}
