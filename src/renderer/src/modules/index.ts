import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { memoryRendererModule } from './memory-module'
import { switchboardRendererModule } from './switchboard-module'
import { createRendererHost, isModuleEnabled, type RendererModule } from './renderer-host'

// Bundled renderer capability modules. Features migrate onto the host one at a
// time; this list grows as each renderer surface is extracted from the
// hardcoded factory switch / panel rail.
export const BUNDLED_RENDERER_MODULES: RendererModule[] = [
  memoryRendererModule,
  switchboardRendererModule,
]

export const BUNDLED_RENDERER_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  BUNDLED_RENDERER_MODULES.map((module) => module.manifest)

// Eager singleton: registering a panel only stores a (lazy) component reference,
// so there's no render cost. The actual bundle loads when the panel renders.
const rendererHost = createRendererHost()
for (const module of BUNDLED_RENDERER_MODULES) {
  module.registerRenderer?.(rendererHost)
}

export function getRendererHost(): ReturnType<typeof createRendererHost> {
  return rendererHost
}

// Reactive enablement selector for store subscriptions. Returns a boolean, so
// it's safe to use directly inside useWorkspaceStore selectors.
export function selectModuleEnabled(
  overrides: ModuleEnablementOverrides,
  moduleId: string
): boolean {
  return isModuleEnabled(BUNDLED_RENDERER_MODULE_MANIFESTS, overrides, moduleId)
}

export type { RendererModule } from './renderer-host'
