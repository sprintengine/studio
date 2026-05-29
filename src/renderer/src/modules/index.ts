import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import { agentRuntimeRendererModule } from './agent-runtime-module'
import { devToolsRendererModule } from './dev-tools-module'
import { gitRendererModule } from './git-module'
import { memoryRendererModule } from './memory-module'
import { mobileRelayRendererModule } from './mobile-relay-module'
import { multiloopRendererModule } from './multiloop-module'
import { sprintEngineRendererModule } from './sprint-engine-module'
import { switchboardRendererModule } from './switchboard-module'
import { createRendererHost, type RendererModule } from './renderer-host'

// Bundled renderer capability modules. Features migrate onto the host one at a
// time; this list grows as each renderer surface is extracted from the
// hardcoded factory switch / panel rail.
export const BUNDLED_RENDERER_MODULES: RendererModule[] = [
  agentRuntimeRendererModule,
  devToolsRendererModule,
  memoryRendererModule,
  gitRendererModule,
  switchboardRendererModule,
  multiloopRendererModule,
  sprintEngineRendererModule,
  mobileRelayRendererModule,
]

export const BUNDLED_RENDERER_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  BUNDLED_RENDERER_MODULES.map((module) => module.manifest)

// Eager singleton: registering a panel only stores a (lazy) component reference,
// so there's no render cost. The actual bundle loads when the panel renders.
// Each module registers through a scoped host so its panels record their owning
// module id (used by the factory to gate a host panel by enablement).
const rendererHost = createRendererHost()
for (const module of BUNDLED_RENDERER_MODULES) {
  module.registerRenderer?.(rendererHost.hostFor(module.manifest.id))
}

export function getRendererHost(): ReturnType<typeof createRendererHost> {
  return rendererHost
}

// Resolving the module graph is pure but non-trivial (map build + dependency
// fixpoint + topo sort), and `selectModuleEnabled` runs inside many Zustand
// selectors on every store update. Memoize the resolved enabled-set per
// overrides object: the store hands out a new `appSettings.modules` reference
// only when enablement actually changes, so this is one resolution per change
// rather than one per call site per render.
const enabledSetCache = new WeakMap<object, Set<string>>()

function enabledModuleSet(overrides: ModuleEnablementOverrides): Set<string> {
  if (!overrides || typeof overrides !== 'object') {
    return new Set(resolveModuleEnablement([...BUNDLED_RENDERER_MODULE_MANIFESTS], {}).order)
  }
  let set = enabledSetCache.get(overrides)
  if (!set) {
    set = new Set(
      resolveModuleEnablement([...BUNDLED_RENDERER_MODULE_MANIFESTS], overrides).order
    )
    enabledSetCache.set(overrides, set)
  }
  return set
}

// Reactive enablement selector for store subscriptions. Returns a boolean, so
// it's safe to use directly inside useWorkspaceStore selectors.
export function selectModuleEnabled(
  overrides: ModuleEnablementOverrides,
  moduleId: string
): boolean {
  return enabledModuleSet(overrides).has(moduleId)
}

export type { RendererModule } from './renderer-host'
