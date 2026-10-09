// Catalog reading for the runtime pickers. Pure functions over the
// renderer-facing plugin catalog (`PluginModelCatalog` / `PluginReasoningCatalog`)
// — this module reads the catalog and never changes it.
//
// Its one non-obvious job is the context-window axis: a model's window variants
// group into one family row, and the window choice rides the reasoning selector
// beside it. The grouping itself lives in src/shared/cli-model-families.ts,
// because `cli.runtime.list` hands a paired phone the same families, and a
// phone that grouped them by rules of its own would draw a different picker.

import type { AgentCli } from '../../types/workspace'
import type { PluginModelCatalog, PluginReasoningCatalog } from '../../../../shared/plugin-manifest'
import type { ModuleChatRuntimeOption } from '../../../../shared/modules/conversation-service'

export {
  buildModelFamilies,
  familyForModel,
  parseModelWindow,
  type CliModelFamily,
} from '../../../../shared/cli-model-families'

// Structurally compatible with AgentCliCatalogOption from
// newWorkspace/cliRuntimeOptions; declared here so the ui primitive does not
// import from a workspace module.
export type CliRuntimeOption = {
  value: AgentCli
  label: string
  modelSelection?: PluginModelCatalog
  reasoningSelection?: PluginReasoningCatalog
  hostedVia?: 'claude-code'
}

/**
 * What a picker accepts: the app's own catalog rows, or the runtimes a module
 * reads from `RendererHost.listChatRuntimes()`, handed over as they come. The
 * two are told apart by shape — a catalog row has a `value`, a chat runtime an
 * `id` — so a module never writes the mapper itself.
 */
export type CliRuntimePickerOption = CliRuntimeOption | ModuleChatRuntimeOption

function isChatRuntimeOption(option: CliRuntimePickerOption): option is ModuleChatRuntimeOption {
  return !('value' in option)
}

/**
 * Normalize a picker's options to catalog rows. A chat runtime's `models`
 * become its model catalog, closed to custom ids because `openChat` only takes
 * the ids it was offered; a runtime with no models offers no model choice. A
 * runtime this machine does not have is left out — unless it is the one
 * already chosen, which the picker must still be able to name.
 */
export function normalizeCliRuntimeOptions(
  options: ReadonlyArray<CliRuntimePickerOption>,
  current?: AgentCli,
): CliRuntimeOption[] {
  return options.flatMap((option): CliRuntimeOption[] => {
    if (!isChatRuntimeOption(option)) return [option]
    if (!option.available && option.id !== current) return []
    return [
      {
        value: option.id,
        label: option.label,
        ...(option.models.length > 0
          ? {
              modelSelection: {
                options: option.models.map((model) => ({ id: model.id, label: model.label })),
                allowCustomId: false,
              },
            }
          : {}),
      },
    ]
  })
}

// A model's raw id, shown beside its friendly label only when it adds
// information the label does not already carry — `opus[1m]` beside "Opus"
// stays, `gpt-5.5` beside "GPT-5.5" goes. The test is one-directional: the id
// is dropped when the LABEL already spells out everything the id says, ignoring
// case and separators. It is kept whenever the id carries something the name
// does not, because that something (a context-window variant, a vendor
// namespace) is exactly what a person needs to tell two rows apart.
export function meaningfulModelId(id: string, label: string | undefined): string | undefined {
  if (!label) return undefined // the row already renders the bare id in the mono face
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const normalizedId = normalize(id)
  const normalizedLabel = normalize(label)
  if (!normalizedId || !normalizedLabel) return undefined
  return normalizedLabel.includes(normalizedId) ? undefined : id
}
