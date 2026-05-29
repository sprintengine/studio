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
  getPanel(componentId: string): WorkspacePanelComponent | undefined
}

export function createRendererHost(): RendererHost {
  const panels = new Map<string, WorkspacePanelComponent>()
  return {
    registerPanel(componentId, component) {
      if (panels.has(componentId)) {
        throw new Error(`Renderer panel "${componentId}" is already registered.`)
      }
      panels.set(componentId, component)
    },
    getPanel(componentId) {
      return panels.get(componentId)
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
