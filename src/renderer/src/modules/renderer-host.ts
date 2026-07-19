import type { ComponentType, LazyExoticComponent } from 'react'

import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import { COMMAND_REGISTRY } from '../commands/commandRegistry'
import { collapseDuplicateKeybindings } from '../commands/keybindings'
import type { CommandAvailability, CommandContribution, CommandScope } from '../commands/types'
import type {
  AppNotification,
  DiagnosticSource,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
} from '../types/workspace'
import type { BacklogItem, BacklogItemLink, BacklogItemStatus, BacklogResolvedLink } from '../utils/backlog'
import type {
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
  deriveRunGlyph?(workspace: WorkspaceRunGlyphProviderInput): WorkspaceRunGlyph | null
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

// A deep-link action a module contributes for its own notifications. Mirrors
// registerBacklogItemAction: the provider is keyed by the notification `source`
// it owns, enablement-gated, and returns serializable-data-driven actions. An
// action's run() composes shell capabilities (revealWorkspace) — the
// notification record itself never carries a callback (it persists to
// localStorage). The shell supplies a generic workspace-reveal fallback when no
// provider matches, so Open works for every workspace type; a provider only
// adds deeper focus on top.
export type NotificationActionContext = {
  notification: AppNotification
  /** Shell capability: switch the active workspace in the current window. */
  revealWorkspace(workspaceId: string): void
}

export type NotificationAction = {
  id: string
  label: string
  isVisible?(context: NotificationActionContext): boolean
  run(context: NotificationActionContext): void | Promise<void>
}

export type NotificationActionProvider = {
  /** The notification source this provider owns (e.g. 'sprintengine'). */
  source: DiagnosticSource
  resolveActions(context: NotificationActionContext): NotificationAction[]
}

export type RegisteredNotificationActionProvider = NotificationActionProvider & {
  moduleId: string
}

// A command contributed by a module. Unlike shell CommandDefinitions, module
// commands carry their handler callback directly — handlerPath indirection is
// a shell-internal idiom. The registered command id is namespaced
// `<moduleId>.<id>`, so user keybinding overrides persist by full id and
// survive module disable/enable cycles (storage keeps them; consumers filter
// by enablement instead).
export type ModuleCommandDefinition = {
  /** Bare command id; the registered id becomes `<moduleId>.<id>`. */
  id: string
  title: string
  /** Grouping label in the palette and Shortcuts settings, e.g. the module's display name. */
  category: string
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  availability?: readonly CommandAvailability[]
  allowInEditableTarget?: boolean
  run: () => void | Promise<void>
}

export type RegisteredModuleCommand = CommandContribution & {
  moduleId: string
  run: () => void | Promise<void>
}

// A Settings overlay section contributed by a module. The host owns
// persistence: section values live in the module's `module:<id>` namespace
// inside the existing app-settings storage (never a new store or file), so
// they survive module disable/enable cycles and app restarts.
export type SettingsSectionProps = {
  values: Readonly<Record<string, unknown>>
  /** Persist one value in the module's namespace; `undefined` deletes the key. */
  setValue: (key: string, value: unknown) => void
}

export type SettingsSectionComponent =
  | ComponentType<SettingsSectionProps>
  | LazyExoticComponent<ComponentType<SettingsSectionProps>>

// Brand constraint: icons follow the house glyph pattern (24×24 viewBox,
// fill="none", currentColor strokes). The Settings rail sizes and tints the
// glyph via className; a module must not bake in its own colors.
export type SettingsSectionIconComponent = ComponentType<{ className?: string }>

export type SettingsSectionDefinition = {
  id: string
  label: string
  /** One-line rail description; the overlay falls back to naming the owning module. */
  description?: string
  icon: SettingsSectionIconComponent
  /** Eager component or React.lazy() wrapper, mirroring WorkspacePanelComponent. */
  Component: SettingsSectionComponent
  /** Sort hint among contributed sections; built-in tabs always render first. */
  order?: number
}

export type RegisteredSettingsSection = SettingsSectionDefinition & {
  moduleId: string
}

// A top-nav door a module contributes to the workspace sidebar's instance-level
// nav cluster (the band that holds New chat, Automations, Sprints, Connectors).
// The entry is a self-contained row component so it owns its full behavior —
// a status dot, an open action against the LOCAL window's store, active-state —
// exactly like the shell's own doors; the host only owns placement + gating.
// Consumers filter by the owning module's enablement and sort by `order`, so a
// module toggle adds/removes its door without a reload, at a deterministic slot.
export type SidebarNavEntryRenderProps = {
  /** The sidebar is collapsed to the icon rail; render icon-only with a tooltip. */
  collapsed: boolean
}

export type SidebarNavEntryComponent =
  | ComponentType<SidebarNavEntryRenderProps>
  | LazyExoticComponent<ComponentType<SidebarNavEntryRenderProps>>

export type SidebarNavEntryDefinition = {
  id: string
  /**
   * Sort key within the top-nav cluster; lower renders first. The shell's
   * built-in doors reserve Create=0, Automations=10, Sprints=20, Connectors=30,
   * so a module door slots deterministically around them (Roadmap uses 40, after
   * Connectors). Ties break on id.
   */
  order: number
  /** The row. Rendered as its own element so it may use hooks and own its behavior. */
  Component: SidebarNavEntryComponent
}

export type RegisteredSidebarNavEntry = SidebarNavEntryDefinition & {
  moduleId: string
}

// Read access to the workspace's Backlog for module renderers. The kernel owns
// only the seam: the backlog module provides the implementation (shared scan +
// watcher), and the scoped host methods below route through it — the kernel
// never imports backlog internals.
export type BacklogReader = {
  list(workspaceId: string): Promise<BacklogItem[]>
  /** Fires once with the current snapshot, then on every change; returns the unsubscriber. */
  watch(workspaceId: string, cb: (items: BacklogItem[]) => void): () => void
}

export type RendererHost = {
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
  registerWorkspaceType(definition: WorkspaceTypeDefinition): void
  registerBacklogItemAction(action: BacklogItemAction): void
  registerBacklogLinkProvider(provider: BacklogLinkProvider): void
  registerNotificationActionProvider(provider: NotificationActionProvider): void
  registerCommand(definition: ModuleCommandDefinition): void
  registerSettingsSection(definition: SettingsSectionDefinition): void
  /**
   * Contribute a top-nav door to the workspace sidebar's instance-level nav
   * cluster. Registered unconditionally at boot; the sidebar filters by this
   * module's enablement and orders by `order`, so a module toggle shows/hides
   * the door without a reload. The row acts on the local window's store.
   */
  registerSidebarNavEntry(definition: SidebarNavEntryDefinition): void
  /**
   * Invoke an IPC channel this module's own `entry.main` registered via
   * `MainHost.registerIpc`. The channel must be `<moduleId>:`-prefixed —
   * validated here before any IPC, and again by the main-side dispatcher,
   * which also requires the owning module to be third-party and to declare
   * the `ipc:invoke` permission. A contract, not a security boundary.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>
  /**
   * Provide the Backlog read implementation (backlog module only — a single
   * slot, ownership-guarded like registerBacklogLinkProvider).
   */
  provideBacklogReader(reader: BacklogReader): void
  /** The workspace's Backlog items (read-only views; mutate via BacklogItemActionContext). */
  listBacklogItems(workspaceId: string): Promise<BacklogItem[]>
  /** Observe the workspace's Backlog: fires with the current snapshot, then on change. */
  watchBacklogItems(workspaceId: string, cb: (items: BacklogItem[]) => void): () => void
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
  getNotificationActionProviders(
    moduleEnabled?: (moduleId: string) => boolean
  ): RegisteredNotificationActionProvider[]
  getModuleCommand(commandId: string): RegisteredModuleCommand | undefined
  getModuleCommands(moduleEnabled?: (moduleId: string) => boolean): RegisteredModuleCommand[]
  /**
   * The one merge point for the command pipeline: the static shell registry
   * followed by enabled module commands. The palette, the keyboard dispatcher,
   * and the Shortcuts settings tab all consume this so a module toggle removes
   * (and re-enabling restores) a command everywhere at once, without a reload.
   * Shell commands come first, so on a duplicate binding at equal scope
   * specificity the dispatcher keeps firing the built-in.
   */
  getCommandContributions(moduleEnabled?: (moduleId: string) => boolean): CommandContribution[]
  /**
   * Contributed Settings sections for enabled modules, in stable order
   * (order hint, then id) regardless of registration order, so the rail reads
   * the same across reloads. The overlay renders these after built-in tabs.
   */
  getSettingsSections(moduleEnabled?: (moduleId: string) => boolean): RegisteredSettingsSection[]
  /**
   * Contributed sidebar nav doors for enabled modules, sorted by `order` then
   * id so the top-nav cluster reads the same across reloads. The sidebar merges
   * these with its own built-in doors (Create/Automations/Sprints/Connectors),
   * which carry their own `order`, into one deterministic band.
   */
  getSidebarNavEntries(moduleEnabled?: (moduleId: string) => boolean): RegisteredSidebarNavEntry[]
  /**
   * Enablement source for host methods that must gate on a module's live
   * enablement without a caller-supplied predicate (the Backlog read API).
   * Wired once at boot by modules/index.ts from the workspace store; absent
   * (early boot, tests) the reader's owning module is treated as enabled.
   */
  setModuleEnablementResolver(resolver: (moduleId: string) => boolean): void
}

const SHELL_COMMAND_IDS: ReadonlySet<string> = new Set(COMMAND_REGISTRY.map((command) => command.id))

export function createRendererHost(): RendererKernel {
  const panels = new Map<string, WorkspacePanelComponent>()
  const panelModules = new Map<string, string>()
  const workspaceTypes = new Map<string, RegisteredWorkspaceTypeDefinition>()
  const backlogItemActions = new Map<string, RegisteredBacklogItemAction>()
  const backlogLinkProviders = new Map<string, BacklogLinkProvider>()
  const notificationActionProviders = new Map<DiagnosticSource, RegisteredNotificationActionProvider>()
  const moduleCommands = new Map<string, RegisteredModuleCommand>()
  const settingsSections = new Map<string, RegisteredSettingsSection>()
  const sidebarNavEntries = new Map<string, RegisteredSidebarNavEntry>()
  let backlogReader: { moduleId: string; reader: BacklogReader } | null = null
  let moduleEnabledResolver: ((moduleId: string) => boolean) | null = null
  // Shared gate for the Backlog read methods: the error names the actual cause
  // so a module author can tell "nothing provides this" from "the user turned
  // the backlog module off".
  const requireBacklogReader = (): BacklogReader => {
    if (!backlogReader) {
      throw new Error('No Backlog reader is registered — the backlog module did not load.')
    }
    if (moduleEnabledResolver && !moduleEnabledResolver(backlogReader.moduleId)) {
      throw new Error('The Backlog module is disabled.')
    }
    return backlogReader.reader
  }
  const enabledModuleCommands = (moduleEnabled?: (moduleId: string) => boolean): RegisteredModuleCommand[] =>
    [...moduleCommands.values()]
      .filter((command) => !moduleEnabled || moduleEnabled(command.moduleId))
      .sort((a, b) => a.id.localeCompare(b.id))
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
        registerNotificationActionProvider(provider) {
          if (notificationActionProviders.has(provider.source)) {
            const owner = notificationActionProviders.get(provider.source)
            throw new Error(
              `Notification action provider for source "${provider.source}" is already registered by module "${owner?.moduleId}".`
            )
          }
          notificationActionProviders.set(provider.source, { ...provider, moduleId })
        },
        registerCommand(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Module command id must be a non-empty string.')
          }
          const commandId = `${moduleId}.${definition.id}`
          if (SHELL_COMMAND_IDS.has(commandId)) {
            throw new Error(`Command "${commandId}" is already registered by the application command registry.`)
          }
          if (moduleCommands.has(commandId)) {
            throw new Error(`Module command "${commandId}" is already registered.`)
          }
          if (definition.title.trim().length === 0) {
            throw new Error(`Module command "${commandId}" must have a non-empty title.`)
          }
          if (definition.scopes.length === 0) {
            throw new Error(`Module command "${commandId}" must declare at least one scope.`)
          }
          moduleCommands.set(commandId, {
            ...definition,
            id: commandId,
            moduleId,
            defaultKeybindings: definition.defaultKeybindings
              ? collapseDuplicateKeybindings(definition.defaultKeybindings)
              : undefined,
          })
        },
        registerSettingsSection(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Settings section id must be a non-empty string.')
          }
          const existing = settingsSections.get(definition.id)
          if (existing) {
            throw new Error(
              `Settings section "${definition.id}" is already registered by module "${existing.moduleId}".`
            )
          }
          settingsSections.set(definition.id, { ...definition, moduleId })
        },
        registerSidebarNavEntry(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Sidebar nav entry id must be a non-empty string.')
          }
          const existing = sidebarNavEntries.get(definition.id)
          if (existing) {
            throw new Error(
              `Sidebar nav entry "${definition.id}" is already registered by module "${existing.moduleId}".`
            )
          }
          sidebarNavEntries.set(definition.id, { ...definition, moduleId })
        },
        provideBacklogReader(reader) {
          if (backlogReader) {
            throw new Error(
              `The Backlog reader is already provided by module "${backlogReader.moduleId}".`
            )
          }
          backlogReader = { moduleId, reader }
        },
        async listBacklogItems(workspaceId) {
          return requireBacklogReader().list(workspaceId)
        },
        watchBacklogItems(workspaceId, cb) {
          const reader = requireBacklogReader()
          return reader.watch(workspaceId, (items) => {
            // Live gate on every delivery, not just at subscribe: an active
            // watch stops streaming the moment the user disables the backlog
            // module (and resumes on re-enable) instead of outliving the
            // toggle. The provider is re-read so the gate follows ownership.
            if (
              backlogReader
              && moduleEnabledResolver
              && !moduleEnabledResolver(backlogReader.moduleId)
            ) {
              return
            }
            try {
              cb(items)
            } catch (error) {
              // A throwing module callback must not break the shared scan's
              // emit loop for sibling subscribers (the Backlog panel included).
              console.error(`[modules] backlog watch callback from module "${moduleId}" threw:`, error)
            }
          })
        },
        async invoke(channel, payload) {
          if (!channel.startsWith(`${moduleId}:`)) {
            throw new Error(
              `Module "${moduleId}" may only invoke its own channels ("${moduleId}:*"); got "${channel}".`
            )
          }
          const outcome = await window.api.moduleBridgeInvoke(channel, payload)
          if (!outcome.ok) {
            // Keep the structured refusal code on the thrown error so module
            // code can branch on the refusal kind without parsing prose.
            throw Object.assign(new Error(outcome.message), { code: outcome.code })
          }
          return outcome.result
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
    getNotificationActionProviders(moduleEnabled) {
      return [...notificationActionProviders.values()]
        .filter((provider) => !moduleEnabled || moduleEnabled(provider.moduleId))
        .sort((a, b) => a.source.localeCompare(b.source))
    },
    getModuleCommand(commandId) {
      return moduleCommands.get(commandId)
    },
    getModuleCommands(moduleEnabled) {
      return enabledModuleCommands(moduleEnabled)
    },
    getCommandContributions(moduleEnabled) {
      return [...COMMAND_REGISTRY, ...enabledModuleCommands(moduleEnabled)]
    },
    getSettingsSections(moduleEnabled) {
      return [...settingsSections.values()]
        .filter((section) => !moduleEnabled || moduleEnabled(section.moduleId))
        .sort((a, b) => {
          const order = (a.order ?? 100) - (b.order ?? 100)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getSidebarNavEntries(moduleEnabled) {
      return [...sidebarNavEntries.values()]
        .filter((entry) => !moduleEnabled || moduleEnabled(entry.moduleId))
        .sort((a, b) => {
          const order = a.order - b.order
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    setModuleEnablementResolver(resolver) {
      moduleEnabledResolver = resolver
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
