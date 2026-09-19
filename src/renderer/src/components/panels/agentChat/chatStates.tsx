// What the chat shows before there is a conversation: the empty state and
// the readiness states.

import React from 'react'
import { ChatGlyph } from './modelPicker'
import { CardButton, OutlineButton } from '../../ui'

// ── Readiness gating ────────────────────────────────────────────────────────

export type ChatReadiness =
  | { kind: 'loading' }
  | { kind: 'no-workspace-folder' }
  | { kind: 'provider-unavailable'; providerId: string }
  | { kind: 'model-unavailable'; providerId: string; modelId: string }
  | { kind: 'missing-key'; providerId: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

export const READINESS_COPY: Record<Exclude<ChatReadiness['kind'], 'ready' | 'loading'>, string> = {
  'no-workspace-folder': 'Open a workspace folder before starting a conversation agent.',
  'provider-unavailable': 'This conversation provider is not installed. Reinstall it to use this agent.',
  'model-unavailable': 'The selected model is not offered by this provider. Pick another model in settings.',
  'missing-key': 'Add an API key for this provider in Settings → Providers before starting.',
  error: 'Conversation providers are unavailable.',
}

export function readinessLabel(readiness: ChatReadiness): string {
  if (readiness.kind === 'ready') return 'Ready'
  if (readiness.kind === 'loading') return 'Checking provider…'
  if (readiness.kind === 'error') return readiness.message
  return READINESS_COPY[readiness.kind]
}

// First-run empty state: the contract in one sentence, three real starting
// prompts, and the cost answer before anyone asks. No decorative hero.
export function EmptyChatState({
  assistantName,
  onSuggestion,
}: {
  assistantName: string
  onSuggestion: (text: string) => void
}) {
  const suggestions: Array<{ text: string; glyph: React.ReactNode }> = [
    {
      text: 'Explain how this codebase is organized',
      glyph: <MagnifierGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />,
    },
    {
      text: 'Add a small feature and tests for it',
      glyph: <PlusGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />,
    },
    {
      text: 'Review my uncommitted changes',
      glyph: <ShieldGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />,
    },
  ]
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <ChatGlyph className="mb-4 h-[30px] w-[30px] text-[color:var(--text-subtle)]" />
      <h2 className="mb-1 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
        Ask {assistantName} about this workspace
      </h2>
      <p className="mb-5 max-w-[44ch] text-body leading-[1.55] text-[color:var(--text-muted)]">
        It reads your code, runs tools with your approval, and remembers the conversation across restarts.
      </p>
      <div className="flex w-full max-w-[420px] flex-col gap-1.5 text-left">
        {suggestions.map((suggestion) => (
          <CardButton
            key={suggestion.text}
            variant="bordered"
            onClick={() => onSuggestion(suggestion.text)}
            className="group px-3 py-2.5 text-body"
          >
            <span className="flex w-full items-center gap-2.5">
              {suggestion.glyph}
              <span className="min-w-0 flex-1">{suggestion.text}</span>
              <span
                aria-hidden="true"
                className="text-micro text-[color:var(--text-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
              >
                ⏎
              </span>
            </span>
          </CardButton>
        ))}
      </div>
      <p className="mt-5 text-micro text-[color:var(--text-subtle)]">
        Runs on your Claude subscription · asks before using tools
      </p>
    </div>
  )
}

// Provider-not-ready is a full centered state with a plain-language next step —
// never a bare red sentence. Real actions only.
export function ReadinessState({
  readiness,
  canSwitchModel,
  onSwitchModel,
}: {
  readiness: ChatReadiness
  canSwitchModel: boolean
  onSwitchModel: () => void
}) {
  if (readiness.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-meta text-[color:var(--text-muted)]">Checking provider…</p>
      </div>
    )
  }
  const title =
    readiness.kind === 'provider-unavailable'
      ? 'This conversation provider isn’t installed'
      : readiness.kind === 'model-unavailable'
        ? 'This model isn’t available'
        : readiness.kind === 'missing-key'
          ? 'Add an API key to start'
          : readiness.kind === 'no-workspace-folder'
            ? 'Open a workspace folder first'
            : 'Conversation is unavailable'
  const offerSwitch =
    canSwitchModel &&
    (readiness.kind === 'provider-unavailable' ||
      readiness.kind === 'model-unavailable' ||
      readiness.kind === 'missing-key')
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <ChatGlyph className="mb-4 h-[30px] w-[30px] text-[color:var(--text-subtle)]" />
      <h2 className="mb-1 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">{title}</h2>
      <p className="mb-5 max-w-[44ch] text-body leading-[1.55] text-[color:var(--text-muted)]">
        {readinessLabel(readiness)}
      </p>
      {offerSwitch ? <OutlineButton onClick={onSwitchModel}>Use another model</OutlineButton> : null}
    </div>
  )
}

export function MagnifierGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6.2" cy="6.2" r="3.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9 9l2.8 2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 7h9M7 2.5v9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function ShieldGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.8l5 2v3.4c0 3-2.1 5-5 6-2.9-1-5-3-5-6V3.8l5-2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}
