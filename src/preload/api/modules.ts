import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  ModuleEnablementOverrides,
  ModuleEnablementWriteResult,
} from '../../shared/electron-api'
import type {
  ModuleBridgeInvokeRequest,
  ModuleBridgeInvokeResult,
} from '../../shared/modules/bridge'
import { MODULE_BRIDGE_INVOKE_CHANNEL } from '../../shared/modules/bridge'
import type { ModuleEventEnvelope } from '../../shared/modules/events'
import { MODULE_EVENTS_CHANNEL } from '../../shared/modules/events'
import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
  ThirdPartyRendererEntriesResult,
} from '../../shared/modules/manifest'
import { THIRD_PARTY_RENDERER_ENTRIES_CHANNEL } from '../../shared/modules/manifest'
import type {
  ModuleRegistrySnapshot,
  ModuleRegistrySnapshotWriteResult,
} from '../../shared/modules/registry-snapshot'
import { MODULE_REGISTRY_SNAPSHOT_CHANNEL } from '../../shared/modules/registry-snapshot'

type ModulesIpcRenderer = {
  invoke(channel: 'modules:set-enablement', overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult>
  invoke(
    channel: typeof MODULE_REGISTRY_SNAPSHOT_CHANNEL,
    snapshot: ModuleRegistrySnapshot
  ): Promise<ModuleRegistrySnapshotWriteResult>
  invoke(channel: 'modules:third-party:list'): Promise<ThirdPartyModuleListResult>
  invoke(channel: 'modules:third-party:install-folder', srcDir: string): Promise<ThirdPartyModuleInstallResult>
  invoke(
    channel: 'modules:third-party:set-trust',
    payload: { id: string; trusted: boolean }
  ): Promise<ThirdPartyModuleTrustResult>
  invoke(channel: typeof THIRD_PARTY_RENDERER_ENTRIES_CHANNEL): Promise<ThirdPartyRendererEntriesResult>
  invoke(
    channel: typeof MODULE_BRIDGE_INVOKE_CHANNEL,
    request: ModuleBridgeInvokeRequest
  ): Promise<ModuleBridgeInvokeResult>
  on(
    channel: typeof MODULE_EVENTS_CHANNEL | 'modules:third-party:changed',
    listener: (event: IpcRendererEvent, envelope: ModuleEventEnvelope) => void
  ): unknown
  removeListener(
    channel: typeof MODULE_EVENTS_CHANNEL | 'modules:third-party:changed',
    listener: (event: IpcRendererEvent, envelope: ModuleEventEnvelope) => void
  ): unknown
}

export function createModulesApi(renderer: ModulesIpcRenderer) {
  return {
    setModuleEnablement: (
      overrides: ModuleEnablementOverrides
    ): Promise<ModuleEnablementWriteResult> => renderer.invoke('modules:set-enablement', overrides),
    setModuleRegistrySnapshot: (
      snapshot: ModuleRegistrySnapshot
    ): Promise<ModuleRegistrySnapshotWriteResult> =>
      renderer.invoke(MODULE_REGISTRY_SNAPSHOT_CHANNEL, snapshot),
    listThirdPartyModules: (): Promise<ThirdPartyModuleListResult> =>
      renderer.invoke('modules:third-party:list'),
    installThirdPartyModuleFolder: (srcDir: string): Promise<ThirdPartyModuleInstallResult> =>
      renderer.invoke('modules:third-party:install-folder', srcDir),
    setThirdPartyModuleTrust: (id: string, trusted: boolean): Promise<ThirdPartyModuleTrustResult> =>
      renderer.invoke('modules:third-party:set-trust', { id, trusted }),
    listThirdPartyRendererEntries: (): Promise<ThirdPartyRendererEntriesResult> =>
      renderer.invoke(THIRD_PARTY_RENDERER_ENTRIES_CHANNEL),
    onThirdPartyModulesChanged: (cb: () => void) => {
      const handler = () => cb()
      renderer.on('modules:third-party:changed', handler)
      return () => renderer.removeListener('modules:third-party:changed', handler)
    },
    moduleBridgeInvoke: (channel: string, payload?: unknown): Promise<ModuleBridgeInvokeResult> =>
      renderer.invoke(MODULE_BRIDGE_INVOKE_CHANNEL, { channel, payload }),
    // Every module's events ride this one channel; the renderer kernel fans
    // them out to the owning module's subscribers. The preload stays neutral —
    // it never inspects `sourceModuleId`, exactly as it never inspects a
    // notification's.
    onModuleEvent: (cb: (envelope: ModuleEventEnvelope) => void) => {
      const handler = (_: IpcRendererEvent, envelope: ModuleEventEnvelope) => cb(envelope)
      renderer.on(MODULE_EVENTS_CHANNEL, handler)
      return () => renderer.removeListener(MODULE_EVENTS_CHANNEL, handler)
    },
  } satisfies Pick<
    ElectronApi,
    | 'setModuleEnablement'
    | 'setModuleRegistrySnapshot'
    | 'listThirdPartyModules'
    | 'installThirdPartyModuleFolder'
    | 'setThirdPartyModuleTrust'
    | 'listThirdPartyRendererEntries'
    | 'onThirdPartyModulesChanged'
    | 'moduleBridgeInvoke'
    | 'onModuleEvent'
  >
}

export const modulesApi = createModulesApi(ipcRenderer)
