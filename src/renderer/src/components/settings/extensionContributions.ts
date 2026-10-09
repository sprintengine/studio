// What an installed extension adds to the app, for its details popover.
//
// Read from what the module actually REGISTERED, never from what it says it
// will: the renderer registry for its window code (doors, workspace types,
// dialogs, commands, settings sections, top-bar controls, Backlog and file
// actions) and, from main, the MCP tools its background code put on the
// gateway this session. A module whose code has not run here — untrusted,
// off since launch, or waiting on a restart — registered nothing, so its
// "Adds" is unknown and the popover leaves the section out rather than
// claiming it adds nothing.
//
// SDK follow-up: a manifest `contributes` block would let the trust review say
// what a module adds BEFORE any of its code has run.

import type { ComponentType } from 'react'

type Owned = { moduleId: string }
type Labelled = Owned & { id: string; label?: string; Icon?: ComponentType<{ className?: string }> }

/** The slice of the renderer host this reads; the real kernel satisfies it. */
export type ContributionRegistry = {
  getGlobalSurfaces(): ReadonlyArray<Labelled & { views?: ReadonlyArray<{ label: string }> }>
  getWorkspaceTypes(): ReadonlyArray<Owned & { label: string }>
  getModalSurfaces(): ReadonlyArray<Owned & { label: string }>
  getModuleCommands(): ReadonlyArray<Owned>
  getSettingsSections(): ReadonlyArray<Owned & { label: string }>
  getTopBarItems(): ReadonlyArray<Owned>
  getBacklogItemActions(): ReadonlyArray<Owned>
  getFileActions(): ReadonlyArray<Owned>
}

export type ContributionKind = 'door' | 'workspace' | 'dialog' | 'command' | 'settings' | 'top-bar' | 'action' | 'tools'

export type ExtensionContribution = { kind: ContributionKind; label: string }

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const titleCase = (id: string): string => (id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]+/g, ' ') : id)

/**
 * The contributions `moduleId` registered, or null when nothing is known: no
 * window code loaded for it this session and no main-side report.
 */
export function deriveContributions(
  moduleId: string,
  registry: ContributionRegistry,
  options: { rendererLoaded: boolean; mcpTools?: readonly string[] | undefined },
): ExtensionContribution[] | null {
  const mine = <T extends Owned>(list: ReadonlyArray<T>): T[] => list.filter((entry) => entry.moduleId === moduleId)
  const adds: ExtensionContribution[] = []

  if (options.rendererLoaded) {
    for (const surface of mine(registry.getGlobalSurfaces())) {
      if (surface.views?.length) {
        for (const view of surface.views) adds.push({ kind: 'door', label: `${view.label} door` })
      } else {
        adds.push({ kind: 'door', label: `${surface.label ?? titleCase(surface.id)} door` })
      }
    }
    for (const type of mine(registry.getWorkspaceTypes())) {
      adds.push({ kind: 'workspace', label: `${type.label} workspace` })
    }
    for (const modal of mine(registry.getModalSurfaces())) {
      adds.push({ kind: 'dialog', label: modal.label })
    }
    for (const section of mine(registry.getSettingsSections())) {
      adds.push({ kind: 'settings', label: `${section.label} settings` })
    }
    const topBar = mine(registry.getTopBarItems()).length
    if (topBar > 0) adds.push({ kind: 'top-bar', label: count(topBar, 'top-bar control', 'top-bar controls') })
    const commands = mine(registry.getModuleCommands()).length
    if (commands > 0) adds.push({ kind: 'command', label: count(commands, 'command', 'commands') })
    const backlog = mine(registry.getBacklogItemActions()).length
    if (backlog > 0) adds.push({ kind: 'action', label: count(backlog, 'Backlog action', 'Backlog actions') })
    const files = mine(registry.getFileActions()).length
    if (files > 0) adds.push({ kind: 'action', label: count(files, 'file action', 'file actions') })
  }

  const tools = options.mcpTools?.length ?? 0
  if (tools > 0) adds.push({ kind: 'tools', label: count(tools, 'agent tool', 'agent tools') })

  // Nothing loaded and nothing reported: unknown, not empty.
  if (!options.rendererLoaded && options.mcpTools === undefined) return null
  return adds.length > 0 ? adds : null
}

/** The glyph a module's door wears, for its row: the first surface it registered with one. */
export function moduleDoorIcon(
  moduleId: string,
  registry: Pick<ContributionRegistry, 'getGlobalSurfaces'>,
): ComponentType<{ className?: string }> | null {
  return registry.getGlobalSurfaces().find((surface) => surface.moduleId === moduleId && surface.Icon)?.Icon ?? null
}
