import { getRendererHost, selectModuleEnabled } from '../../../modules'
import type { ModuleEnablementOverrides } from '../../../../../shared/modules/manifest'
import { SPRINT_ENGINE_WORKSPACE_MODE } from '../../../types/workspace'
import { CommentIcon, StandardWorkspaceTypeIcon } from '../../AppIcons'
import type { ModeCardModel } from './types'

// 'chat' is a shell-owned pseudo-type, not a registered workspace type: selecting
// it embeds the existing AgentComposer as the chat config surface and creates a
// solo-agent chat via the same path as today's New chat. It leads the hub rail so
// the lightest choice is first.
export const CHAT_MODE_MODEL: ModeCardModel = {
  id: 'chat',
  label: 'Chat',
  description: 'A single agent you chat with, scoped to this project.',
  icon: CommentIcon,
}

// 'standard' is shell-owned (never a registered workspace type), so the hub
// seeds it here and appends the registry-contributed types after it.
export const STANDARD_MODE_MODEL: ModeCardModel = {
  id: 'standard',
  label: 'Workspace',
  description: 'IDE layout with editor, terminals, and file explorer for direct work.',
  icon: StandardWorkspaceTypeIcon,
}

// The creation hub rail renders one gap after the shell-owned pair (Chat,
// Workspace), separating "start working" from the orchestrated types below.
export const CREATION_RAIL_GROUP_BREAK_INDEX = 2

// The two shell-owned entries lead, then Sprint Engine and Design Wizard are
// surfaced ahead of the remaining registry-contributed types (gated by the
// sprint-engine and design-wizard modules respectively — and design-wizard
// dependsOn sprint-engine, so disabling Sprint Engine hides both). The rest
// keep their pickerOrder. getWorkspaceTypes returns a fresh array, so callers memoise this
// on the stable moduleOverrides reference (Zustand v5: selector-derived arrays
// must not be rebuilt each render).
export function buildModeModels(moduleOverrides: ModuleEnablementOverrides): ModeCardModel[] {
  const contributed = getRendererHost()
    .getWorkspaceTypes((moduleId) => selectModuleEnabled(moduleOverrides, moduleId))
    // Runtime-only container types (automations-host) stay registered so their
    // workspaces resolve, but never offer themselves as a create option here.
    .filter((definition) => !definition.hiddenFromPicker)
    .map<ModeCardModel>((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      icon: definition.icon,
    }))
  const featuredIds = [SPRINT_ENGINE_WORKSPACE_MODE, 'guided-brief']
  const byId = new Map(contributed.map((model) => [model.id, model]))
  const featured = featuredIds
    .map((id) => byId.get(id))
    .filter((model): model is ModeCardModel => model !== undefined)
  const rest = contributed.filter((model) => !featuredIds.includes(model.id))
  return [CHAT_MODE_MODEL, STANDARD_MODE_MODEL, ...featured, ...rest]
}
