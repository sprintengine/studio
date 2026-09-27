import React from 'react'
import { ChipButton, OverflowMenu, Tooltip } from '../../ui'
import { ReasoningSelector } from '../../ui/ReasoningSelector'
import type { ConversationCapabilities } from '../../../../../shared/conversation-runtime'

export type ConversationMode = 'default' | 'plan' | 'ask'
export function nextConversationEffort(levels: readonly string[], current?: string): string | undefined {
  if (!levels.length) return undefined
  return levels[(levels.indexOf(current ?? '') + 1) % (levels.length + 1)]
}

/** Low-priority next-turn controls collapse before the model, permissions, or Send. */
export function ConversationModeControls({
  capabilities,
  mode,
  effort,
  compact,
  disabled,
  onMode,
  onEffort,
}: {
  capabilities?: ConversationCapabilities
  mode: ConversationMode
  effort?: string
  compact: boolean
  disabled?: boolean
  onMode: (mode: ConversationMode) => void
  onEffort: (effort: string | undefined) => void
}) {
  const levels = capabilities?.reasoningEfforts ?? []
  const plan = capabilities?.planMode === true
  if (!plan && !levels.length) return null
  if (compact)
    return (
      <OverflowMenu
        ariaLabel="More conversation controls"
        items={[
          ...(plan
            ? [
                {
                  id: 'plan',
                  label: mode === 'plan' ? 'Turn off plan mode' : 'Plan before making changes',
                  disabled,
                  onSelect: () => onMode(mode === 'plan' ? 'default' : 'plan'),
                },
              ]
            : []),
          ...(levels.length
            ? [
                { id: 'effort-heading', kind: 'heading' as const, label: `Reasoning: ${effort ?? 'Auto'}` },
                { id: 'effort-auto', label: 'Use default effort', disabled, onSelect: () => onEffort(undefined) },
                ...levels.map((level) => ({
                  id: `effort-${level}`,
                  label: `${level[0].toUpperCase()}${level.slice(1)} effort`,
                  disabled,
                  onSelect: () => onEffort(level),
                })),
              ]
            : []),
        ]}
      />
    )
  return (
    <>
      {plan ? (
        <Tooltip content="Plan before making changes. Applies from the next turn.">
          <ChipButton
            pressed={mode === 'plan'}
            disabled={disabled}
            onClick={() => onMode(mode === 'plan' ? 'default' : 'plan')}
          >
            Plan
          </ChipButton>
        </Tooltip>
      ) : null}
      {levels.length ? (
        <ReasoningSelector
          ariaLabel="Reasoning effort"
          scope="reasoning"
          quiet
          disabled={disabled}
          reasoningSelection={{ levels: levels.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }}
          reasoning={effort}
          onSelectReasoning={(value) => onEffort(value ?? undefined)}
          onSelectModel={() => undefined}
        />
      ) : null}
    </>
  )
}
