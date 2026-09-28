// What a finished turn says about itself under its reply — the model it ran
// on, the tokens it used, what it cost when that means anything — and the
// divider a context compaction leaves in the transcript.

import type { TranscriptEntry } from './conversationProjection'
import { apiKeyBillingNotice } from '../../../../../shared/conversation/apiKeySource'
import { CONVERSATION_DEFAULT_MODEL_ID } from '../../../../../shared/conversation-harness'
import { CompactGlyph } from './toolRows/ToolKindGlyph'

type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>
type CompactionEntry = Extract<TranscriptEntry, { kind: 'compaction' }>

// 950 → "950", 12_345 → "12.3k", 1_200_000 → "1.2M".
export function formatTokenCount(count: number): string {
  const value = Math.max(0, Math.round(count))
  if (value < 1000) return String(value)
  const [scaled, unit] = value < 999_500 ? [value / 1000, 'k'] : [value / 1_000_000, 'M']
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`
}

// A provider's model id as the footer names it. The dated snapshot suffix is
// noise next to the family and version; the harness's "default" is not a name.
export function formatTurnModel(modelId: string): string {
  if (modelId === CONVERSATION_DEFAULT_MODEL_ID) return 'Default model'
  return modelId.replace(/-\d{8}$/u, '')
}

export type TurnMetaParts = {
  model?: string
  tokens?: string
  cost?: string
}

// The pieces of a settled turn's footer. Cost only for a turn that billed API
// usage: on a subscription the provider still reports a list-price estimate,
// and a dollar figure there reads as a charge that never happens.
export function turnMetaParts(entry: AssistantEntry): TurnMetaParts {
  const parts: TurnMetaParts = {}
  if (entry.modelId) parts.model = formatTurnModel(entry.modelId)
  if (entry.inputTokens !== undefined || entry.outputTokens !== undefined) {
    parts.tokens = `${formatTokenCount(entry.inputTokens ?? 0)} in · ${formatTokenCount(entry.outputTokens ?? 0)} out`
  }
  if (entry.costUsd !== undefined && entry.costUsd > 0 && apiKeyBillingNotice(entry.apiKeySource) !== null) {
    parts.cost = entry.costUsd < 0.01 ? '<$0.01' : `$${entry.costUsd.toFixed(2)}`
  }
  return parts
}

const HOVER_REVEAL = 'opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100'

// The footer's own pieces, laid into the turn's meta line. They wait for hover
// like the clock beside them, except the model right after a switch: that is
// the one thing a reader scanning the transcript needs to see unprompted.
export function TurnMeta({ entry, modelSwitched = false }: { entry: AssistantEntry; modelSwitched?: boolean }) {
  const { model, tokens, cost } = turnMetaParts(entry)
  return (
    <>
      {model && modelSwitched ? (
        <span className="shrink-0 whitespace-nowrap" data-turn-model="">
          {model}
        </span>
      ) : null}
      {model && !modelSwitched ? (
        <span className={`shrink-0 whitespace-nowrap text-[color:var(--text-subtle)] ${HOVER_REVEAL}`}>{model}</span>
      ) : null}
      {tokens ? (
        <span className={`shrink-0 whitespace-nowrap tabular-nums text-[color:var(--text-subtle)] ${HOVER_REVEAL}`}>
          {tokens}
        </span>
      ) : null}
      {cost ? (
        <span className={`shrink-0 whitespace-nowrap tabular-nums text-[color:var(--text-subtle)] ${HOVER_REVEAL}`}>
          {cost}
        </span>
      ) : null}
    </>
  )
}

// "Context compacted · automatically · 182k → 24k tokens".
export function compactionLabel(entry: CompactionEntry): string {
  const tokens =
    entry.preTokens === undefined
      ? undefined
      : entry.postTokens === undefined
        ? `from ${formatTokenCount(entry.preTokens)} tokens`
        : `${formatTokenCount(entry.preTokens)} → ${formatTokenCount(entry.postTokens)} tokens`
  const trigger = entry.trigger === 'auto' ? 'automatically' : entry.trigger === 'manual' ? 'on request' : undefined
  return ['Context compacted', trigger, tokens].filter(Boolean).join(' · ')
}

// Past this line the model works from a summary of the conversation, not the
// conversation itself, so the seam is drawn across the column rather than
// tucked into a turn.
export function CompactionDivider({ entry }: { entry: CompactionEntry }) {
  const label = compactionLabel(entry)
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 pb-6 text-micro text-[color:var(--text-subtle)]"
    >
      <span className="flex-1 border-t border-[color:var(--border-subtle)]" />
      <span className="flex shrink-0 items-center gap-1.5">
        <CompactGlyph className="icon-xs shrink-0 text-[color:var(--text-disabled)]" />
        {label}
      </span>
      <span className="flex-1 border-t border-[color:var(--border-subtle)]" />
    </div>
  )
}
