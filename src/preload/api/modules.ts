import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  ElectronApi,
  ModuleEnablementOverrides,
  ModuleEnablementWriteResult,
  ThirdPartyModuleUninstallInput,
  ThirdPartyModuleUninstallResult,
} from '../../shared/electron-api'
import type { ModuleBridgeInvokeRequest, ModuleBridgeInvokeResult } from '../../shared/modules/bridge'
import { MODULE_BRIDGE_INVOKE_CHANNEL } from '../../shared/modules/bridge'
import type { ModuleHostServiceRequest } from '../../shared/modules/host-service-bridge'
import { MODULE_HOST_SERVICE_CHANNEL } from '../../shared/modules/host-service-bridge'
import type { ModuleEventEnvelope } from '../../shared/modules/events'
import { MODULE_EVENTS_CHANNEL } from '../../shared/modules/events'
import type { ModuleNotificationDelivery } from '../../shared/modules/notifications'
import { MODULE_NOTIFICATIONS_CHANNEL, MODULE_NOTIFICATIONS_RECENT_CHANNEL } from '../../shared/modules/notifications'
import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
  ThirdPartyRendererEntriesResult,
} from '../../shared/modules/manifest'
import { THIRD_PARTY_RENDERER_ENTRIES_CHANNEL } from '../../shared/modules/manifest'
import type { ModuleRegistrySnapshot, ModuleRegistrySnapshotWriteResult } from '../../shared/modules/registry-snapshot'
import { MODULE_REGISTRY_SNAPSHOT_CHANNEL } from '../../shared/modules/registry-snapshot'

type ModulesIpcRenderer = {
  invoke(channel: 'modules:set-enablement', overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult>
  invoke(channel: 'modules:set-app-state', bag: Record<string, Record<string, unknown>>): Promise<void>
  invoke(
    channel: typeof MODULE_REGISTRY_SNAPSHOT_CHANNEL,
    snapshot: ModuleRegistrySnapshot,
  ): Promise<ModuleRegistrySnapshotWriteResult>
  invoke(channel: 'modules:third-party:list'): Promise<ThirdPartyModuleListResult>
  invoke(channel: 'modules:third-party:install-folder', srcDir: string): Promise<ThirdPartyModuleInstallResult>
  invoke(
    channel: 'modules:third-party:set-trust',
    payload: { id: string; trusted: boolean },
  ): Promise<ThirdPartyModuleTrustResult>
  invoke(
    channel: 'modules:third-party:uninstall',
    input: ThirdPartyModuleUninstallInput,
  ): Promise<ThirdPartyModuleUninstallResult>
  invoke(channel: typeof THIRD_PARTY_RENDERER_ENTRIES_CHANNEL): Promise<ThirdPartyRendererEntriesResult>
  invoke(
    channel: typeof MODULE_BRIDGE_INVOKE_CHANNEL,
    request: ModuleBridgeInvokeRequest,
  ): Promise<ModuleBridgeInvokeResult>
  invoke(channel: typeof MODULE_HOST_SERVICE_CHANNEL, request: ModuleHostServiceRequest): Promise<unknown>
  invoke(channel: typeof MODULE_NOTIFICATIONS_RECENT_CHANNEL): Promise<ModuleNotificationDelivery[]>
  on(
    channel: typeof MODULE_NOTIFICATIONS_CHANNEL,
    listener: (event: IpcRendererEvent, notification: ModuleNotificationDelivery) => void,
  ): unknown
  removeListener(
    channel: typeof MODULE_NOTIFICATIONS_CHANNEL,
    listener: (event: IpcRendererEvent, notification: ModuleNotificationDelivery) => void,
  ): unknown
  on(
    channel: typeof MODULE_EVENTS_CHANNEL | 'modules:third-party:changed',
    listener: (event: IpcRendererEvent, envelope: ModuleEventEnvelope) => void,
  ): unknown
  removeListener(
    channel: typeof MODULE_EVENTS_CHANNEL | 'modules:third-party:changed',
    listener: (event: IpcRendererEvent, envelope: ModuleEventEnvelope) => void,
  ): unknown
}

export function createModulesApi(renderer: ModulesIpcRenderer) {
  return {
    setModuleEnablement: (overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult> =>
      renderer.invoke('modules:set-enablement', overrides),
    setModuleAppState: (bag: Record<string, Record<string, unknown>>): Promise<void> =>
      renderer.invoke('modules:set-app-state', bag),
    setModuleRegistrySnapshot: (snapshot: ModuleRegistrySnapshot): Promise<ModuleRegistrySnapshotWriteResult> =>
      renderer.invoke(MODULE_REGISTRY_SNAPSHOT_CHANNEL, snapshot),
    listThirdPartyModules: (): Promise<ThirdPartyModuleListResult> => renderer.invoke('modules:third-party:list'),
    installThirdPartyModuleFolder: (srcDir: string): Promise<ThirdPartyModuleInstallResult> =>
      renderer.invoke('modules:third-party:install-folder', srcDir),
    setThirdPartyModuleTrust: (id: string, trusted: boolean): Promise<ThirdPartyModuleTrustResult> =>
      renderer.invoke('modules:third-party:set-trust', { id, trusted }),
    uninstallThirdPartyModule: (input: ThirdPartyModuleUninstallInput): Promise<ThirdPartyModuleUninstallResult> =>
      renderer.invoke('modules:third-party:uninstall', input),
    listThirdPartyRendererEntries: (): Promise<ThirdPartyRendererEntriesResult> =>
      renderer.invoke(THIRD_PARTY_RENDERER_ENTRIES_CHANNEL),
    onThirdPartyModulesChanged: (cb: () => void) => {
      const handler = () => cb()
      renderer.on('modules:third-party:changed', handler)
      return () => renderer.removeListener('modules:third-party:changed', handler)
    },
    moduleBridgeInvoke: (channel: string, payload?: unknown): Promise<ModuleBridgeInvokeResult> =>
      renderer.invoke(MODULE_BRIDGE_INVOKE_CHANNEL, { channel, payload }),
    moduleHostServiceInvoke: (request: ModuleHostServiceRequest): Promise<unknown> =>
      renderer.invoke(MODULE_HOST_SERVICE_CHANNEL, request),
    // Every module's events ride this one channel; the renderer kernel fans
    // them out to the owning module's subscribers. The preload stays neutral —
    // it never inspects `sourceModuleId`, exactly as it never inspects a
    // notification's.
    onModuleEvent: (cb: (envelope: ModuleEventEnvelope) => void) => {
      const handler = (_: IpcRendererEvent, envelope: ModuleEventEnvelope) => cb(envelope)
      renderer.on(MODULE_EVENTS_CHANNEL, handler)
      return () => renderer.removeListener(MODULE_EVENTS_CHANNEL, handler)
    },
    // Bell rows from every module, the notification twin of the event channel
    // above: the renderer files them, the preload never reads them.
    onModuleNotification: (cb: (notification: ModuleNotificationDelivery) => void) => {
      const handler = (_: IpcRendererEvent, notification: ModuleNotificationDelivery) => cb(notification)
      renderer.on(MODULE_NOTIFICATIONS_CHANNEL, handler)
      return () => renderer.removeListener(MODULE_NOTIFICATIONS_CHANNEL, handler)
    },
    listRecentModuleNotifications: (): Promise<ModuleNotificationDelivery[]> =>
      renderer.invoke(MODULE_NOTIFICATIONS_RECENT_CHANNEL),
  } satisfies Pick<
    ElectronApi,
    | 'setModuleEnablement'
    | 'setModuleAppState'
    | 'setModuleRegistrySnapshot'
    | 'listThirdPartyModules'
    | 'installThirdPartyModuleFolder'
    | 'setThirdPartyModuleTrust'
    | 'uninstallThirdPartyModule'
    | 'listThirdPartyRendererEntries'
    | 'onThirdPartyModulesChanged'
    | 'moduleBridgeInvoke'
    | 'moduleHostServiceInvoke'
    | 'onModuleEvent'
    | 'onModuleNotification'
    | 'listRecentModuleNotifications'
  >
}

export const modulesApi = createModulesApi(ipcRenderer)
