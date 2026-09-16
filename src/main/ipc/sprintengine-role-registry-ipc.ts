import { app } from 'electron'
import { join } from 'path'

import type { IpcInvokeHandler } from '../module-host/main-host'
import { SPRINT_ENGINE_CHANNELS } from '../../shared/sprintengine/ipc-channels'
import {
  defaultUserRoleRegistryRoot,
  installRoleFolder,
  type RoleInstallResult,
} from '../sprintengine-role-registry'

export type SprintEngineRoleRegistryIpcHost = {
  registerIpc(channel: string, handler: IpcInvokeHandler): void
}

// Kernel-level IPC for the user-global Sprint Engine role registry. It's pure
// filesystem config management (validate + copy declarative manifests). Discovery
// of installed roles flows through the existing sprintengine registry read.
//
// There is no mobile role-catalog cache to invalidate alongside it any more: the
// phone's launch picker read the resolved registry off the mobile snapshot, and
// that surface left with the engine (MC-2575).

// The shipped specialist-pack source tree (17 role manifests + their soul
// skills), un-shipped from the bundled registry root in MC-1587. Packaged builds
// receive it via package.json build.extraResources ('resources/specialist-pack'
// → 'resources/specialist-pack'), so it resolves under process.resourcesPath;
// dev checkouts read it from the repo. Its shape is a registry root, so
// installRoleFolder consumes it directly.
function bundledSpecialistPackDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'specialist-pack')
    : join(app.getAppPath(), 'resources', 'specialist-pack')
}

export function registerSprintEngineRoleRegistryIpc(host: SprintEngineRoleRegistryIpcHost): void {
  // One-time MC-1587 update-migration: install the un-shipped specialist pack
  // from the shipped source tree into the user-global root, for users who had
  // the bundled pack enabled before it stopped being bundled. The renderer owns
  // the run-once guard (appSettings.specialistPacks.migratedBundledPack) and the
  // enabled/disabled decision; this handler only performs the copy.
  host.registerIpc(
    SPRINT_ENGINE_CHANNELS.specialistPackInstallBundled,
    (): Promise<RoleInstallResult> => {
      return installRoleFolder(bundledSpecialistPackDir(), defaultUserRoleRegistryRoot())
    },
  )
}
