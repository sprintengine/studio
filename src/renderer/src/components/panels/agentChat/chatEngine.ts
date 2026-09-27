import type { CliRuntimeOption } from '../../ui/CliModelPicker'

// How a chat agent's engine chip reads its CLI's catalog row.

/**
 * The catalog row a chat's picker offers once the chat has started. The runtime
 * binds a session to one model, so the rail keeps the chat's CLI and the list
 * keeps the chat's model alone — effort and permissions stay editable on the
 * trailing row, which is what the picker is for mid-conversation. A chat on the
 * CLI's own default model keeps just the default row.
 */
export function lockedChatEngineOption(option: CliRuntimeOption, model: string | undefined): CliRuntimeOption {
  if (!option.modelSelection) return option
  return {
    ...option,
    modelSelection: {
      ...option.modelSelection,
      options: model ? option.modelSelection.options.filter((entry) => entry.id === model) : [],
    },
  }
}

/**
 * Whether a chat agent's name is one this app derived from its model rather
 * than a name: chats used to be called after their model ("Opus 5.5",
 * "Opus 5.5 2", the raw id, or "Conversation Agent" when there was no label).
 * Such a chat is renamed from the shared pool, as a terminal agent is named,
 * so the model is never the name. A name the person typed is never matched.
 */
export function isModelDerivedChatName(
  name: string | null | undefined,
  modelId: string,
  modelLabels: ReadonlySet<string>,
): boolean {
  const base = (name ?? '').trim().replace(/ \d+$/u, '')
  if (!base) return true
  return base === 'Conversation Agent' || base === modelId || modelLabels.has(base)
}
