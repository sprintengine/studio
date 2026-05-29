import type { ComponentType, LazyExoticComponent } from 'react'

import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'

// Renderer-side host kernel. Mirrors the main-process MainHost: capability
// modules register their contributions (panels for now) into shared registries
// instead of the hardcoded factory switch + lazy-import block in
// WorkspaceLayout.tsx. Enablement is computed reactively from settings so a
// feature can be toggled without a reload.
//
// See future-plans/2026-05-28-feature-level-pluggable-architecture.md.

export type WorkspacePanelProps = { workspaceId: string }

// A panel may be an eager component or a React.lazy() wrapper; both render the
// same way in JSX, and lazy keeps a disabled feature's bundle off the wire.
export type WorkspacePanelComponent =
  | ComponentType<WorkspacePanelProps>
  | LazyExoticComponent<ComponentType<WorkspacePanelProps>>

export type RendererHost = {
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
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
}

export function createRendererHost(): RendererKernel {
  const panels = new Map<string, WorkspacePanelComponent>()
  const panelModules = new Map<string, string>()
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
      }
    },
    getPanel(componentId) {
      return panels.get(componentId)
    },
    getPanelModule(componentId) {
      return panelModules.get(componentId)
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
