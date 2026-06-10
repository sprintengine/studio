import type { ComponentType, LazyExoticComponent } from 'react'

import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import type { FuturePlanWorkspaceSource, LayoutTemplate } from '../types/workspace'
import type { BacklogItem, BacklogItemLink, BacklogItemStatus, BacklogResolvedLink } from '../utils/backlog'
import type {
  WorkspaceActivityKind,
  WorkspaceRunGlyph,
  WorkspaceRunGlyphProviderInput,
} from '../utils/workspaceRunGlyph'

// Renderer-side host kernel. Mirrors the main-process MainHost: capability
// modules register their contributions (panels for now) into shared registries
// instead of the hardcoded factory switch + lazy-import block in
// WorkspaceLayout.tsx. Enablement is computed reactively from settings so a
// feature can be toggled without a reload.
//
// See future-plans/2026-05-28-feature-level-pluggable-architecture.md.

export type WorkspacePanelProps = {
  workspaceId: string
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
}

// A panel may be an eager component or a React.lazy() wrapper; both render the
// same way in JSX, and lazy keeps a disabled feature's bundle off the wire.
export type WorkspacePanelComponent =
  | ComponentType<WorkspacePanelProps>
  | LazyExoticComponent<ComponentType<WorkspacePanelProps>>

export type WorkspaceTypeIconComponent = ComponentType<{ className?: string }>

export type WorkspaceTypeTopBarView = {
  component: string
  name: string
}

export type WorkspaceTypeSupervisorScope = 'global' | 'all-windows'

export type WorkspaceTypeSupervisorComponent =
  | ComponentType
  | LazyExoticComponent<ComponentType>

export type WorkspaceTypeSupervisor = {
  Component: WorkspaceTypeSupervisorComponent
  scope: WorkspaceTypeSupervisorScope
}

export type WorkspaceTypeDefinition = {
  id: string
  label: string
  description: string
  icon: WorkspaceTypeIconComponent
  accentToken?: string
  searchTerms?: string[]
  createTemplate(): LayoutTemplate
  topBarViews?: {
    label: string
    views: WorkspaceTypeTopBarView[]
  }
  isRunGlyphProviderForWorkspace?(workspace: WorkspaceRunGlyphProviderInput): boolean
  deriveRunGlyph?(workspace: WorkspaceRunGlyphProviderInput, activity: WorkspaceActivityKind): WorkspaceRunGlyph | null
  supervisors?: WorkspaceTypeSupervisor[]
  creationStepsId?: string
  pickerOrder?: number
}

export type RegisteredWorkspaceTypeDefinition = WorkspaceTypeDefinition & {
  moduleId: string
}

export type BacklogItemActionCategory = 'execute' | 'analyze' | 'transform' | 'publish' | 'review' | 'organize'

export type BacklogItemActionContext = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  readSource(): Promise<string>
  updateStatus(status: BacklogItemStatus): Promise<void>
  addLink(link: BacklogItemLink): Promise<void>
  updateModuleMetadata(moduleId: string, value: unknown): Promise<void>
  startSourcePlan?(source: FuturePlanWorkspaceSource): void
}

export type BacklogItemActionState = 'enabled' | 'disabled'

export type BacklogItemAction = {
  id: string
  label: string
  category: BacklogItemActionCategory
  order?: number
  isVisible?: (context: BacklogItemActionContext) => boolean
  getState?: (context: BacklogItemActionContext) => BacklogItemActionState
  run: (context: BacklogItemActionContext) => void | Promise<void>
}

export type RegisteredBacklogItemAction = BacklogItemAction & {
  moduleId: string
}

export type BacklogLinkProviderInput = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  link: BacklogItemLink
}

export type BacklogLinkProvider = {
  moduleId: string
  targetKinds: string[]
  resolveLinkStatus(input: BacklogLinkProviderInput): Promise<BacklogResolvedLink>
  openLink?(input: BacklogLinkProviderInput): Promise<void | boolean>
}

export type RendererHost = {
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
  registerWorkspaceType(definition: WorkspaceTypeDefinition): void
  registerBacklogItemAction(action: BacklogItemAction): void
  registerBacklogLinkProvider(provider: BacklogLinkProvider): void
}

// The kernel owns the registries and is consumed by the factory/rail. Modules
// register through a scoped `hostFor(moduleId)` (mirroring the main-process
// MainKernel) so each panel records its owning module — that's what lets the
// factory gate a host panel by its module's enablement without a per-feature
// switch arm.
export type RendererKernel = {
  hostFor(moduleId: string): RendererHost
  getPanel(componentId: string): WorkspacePanelComponent | undefined
  /** The capability module that registered the panel, for enablement gating. */
  getPanelModule(componentId: string): string | undefined
  getWorkspaceType(id: string): RegisteredWorkspaceTypeDefinition | undefined
  getWorkspaceTypes(moduleEnabled?: (moduleId: string) => boolean): RegisteredWorkspaceTypeDefinition[]
  getWorkspaceTypeModule(id: string): string | undefined
  getBacklogItemActions(): RegisteredBacklogItemAction[]
  getBacklogLinkProviders(moduleEnabled?: (moduleId: string) => boolean): BacklogLinkProvider[]
}

export function createRendererHost(): RendererKernel {
  const panels = new Map<string, WorkspacePanelComponent>()
  const panelModules = new Map<string, string>()
  const workspaceTypes = new Map<string, RegisteredWorkspaceTypeDefinition>()
  const backlogItemActions = new Map<string, RegisteredBacklogItemAction>()
  const backlogLinkProviders = new Map<string, BacklogLinkProvider>()
  return {
    hostFor(moduleId) {
      return {
        registerPanel(componentId, component) {
          if (panels.has(componentId)) {
            throw new Error(`Renderer panel "${componentId}" is already registered.`)
          }
          panels.set(componentId, component)
          panelModules.set(componentId, moduleId)
        },
        registerWorkspaceType(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Workspace type id must be a non-empty string.')
          }
          if (definition.id === 'standard') {
            throw new Error('Workspace type "standard" is shell-owned and cannot be registered.')
          }
          if (workspaceTypes.has(definition.id)) {
            throw new Error(`Workspace type "${definition.id}" is already registered.`)
          }
          workspaceTypes.set(definition.id, { ...definition, moduleId })
        },
        registerBacklogItemAction(action) {
          if (backlogItemActions.has(action.id)) {
            throw new Error(`Backlog item action "${action.id}" is already registered.`)
          }
          backlogItemActions.set(action.id, { ...action, moduleId })
        },
        registerBacklogLinkProvider(provider) {
          if (provider.moduleId !== moduleId) {
            throw new Error(`Backlog link provider "${provider.moduleId}" must be registered by its owning module "${moduleId}".`)
          }
          if (provider.targetKinds.length === 0) {
            throw new Error(`Backlog link provider "${provider.moduleId}" must own at least one target kind.`)
          }
          const uniqueTargetKinds = new Set(provider.targetKinds)
          if (uniqueTargetKinds.size !== provider.targetKinds.length) {
            throw new Error(`Backlog link provider "${provider.moduleId}" declares duplicate target kinds.`)
          }
          for (const targetKind of provider.targetKinds) {
            const owner = backlogLinkProviders.get(targetKind)
            if (owner) {
              throw new Error(`Backlog link target kind "${targetKind}" is already owned by module "${owner.moduleId}".`)
            }
          }
          for (const targetKind of provider.targetKinds) {
            backlogLinkProviders.set(targetKind, provider)
          }
        },
      }
    },
    getPanel(componentId) {
      return panels.get(componentId)
    },
    getPanelModule(componentId) {
      return panelModules.get(componentId)
    },
    getWorkspaceType(id) {
      return workspaceTypes.get(id)
    },
    getWorkspaceTypes(moduleEnabled) {
      // The module list registers eagerly at boot and these definitions are
      // stored by reference, so lookups are stable. Components that derive
      // arrays from this registry should still memoize those arrays before
      // returning them from Zustand selectors.
      return [...workspaceTypes.values()]
        .filter((definition) => !moduleEnabled || moduleEnabled(definition.moduleId))
        .sort((a, b) => {
          const order = (a.pickerOrder ?? 100) - (b.pickerOrder ?? 100)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getWorkspaceTypeModule(id) {
      return workspaceTypes.get(id)?.moduleId
    },
    getBacklogItemActions() {
      return [...backlogItemActions.values()].sort((a, b) => {
        const order = (a.order ?? 100) - (b.order ?? 100)
        return order === 0 ? a.label.localeCompare(b.label) : order
      })
    },
    getBacklogLinkProviders(moduleEnabled) {
      const providers = new Set<BacklogLinkProvider>()
      for (const provider of backlogLinkProviders.values()) {
        if (moduleEnabled && !moduleEnabled(provider.moduleId)) continue
        providers.add(provider)
      }
      return [...providers].sort((a, b) => {
        const moduleOrder = a.moduleId.localeCompare(b.moduleId)
        return moduleOrder === 0 ? a.targetKinds.join('\0').localeCompare(b.targetKinds.join('\0')) : moduleOrder
      })
    },
  }
}

export type RendererModule = {
  manifest: CapabilityManifest
  registerRenderer?: (host: RendererHost) => void
}

// Pure helper shared by the factory, the panel rail, and the Modules settings
// tab so "is this feature on?" is computed identically everywhere.
export function isModuleEnabled(
  manifests: ReadonlyArray<CapabilityManifest>,
  overrides: ModuleEnablementOverrides,
  moduleId: string
): boolean {
  return resolveModuleEnablement([...manifests], overrides).order.includes(moduleId)
}
