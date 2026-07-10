import type { IpcMain } from 'electron'
import type {
  SprintRuntimeRunRegistration,
  SprintRuntimeStopReasonPush,
} from '../../shared/sprintengine/runtime-bridge'
import type { SprintRuntime } from '../sprint-runtime'

type SprintRuntimeIpcDependencies = {
  sprintRuntime: Pick<SprintRuntime, 'registerRun' | 'unregisterRun' | 'applyStopReason'>
}

export function registerSprintRuntimeIpc(
  ipcMain: IpcMain,
  deps: SprintRuntimeIpcDependencies,
): void {
  ipcMain.handle('sprintengine:runtime:register-run', (_event, payload: SprintRuntimeRunRegistration) => {
    deps.sprintRuntime.registerRun(payload)
    return { ok: true as const }
  })

  ipcMain.handle('sprintengine:runtime:unregister-run', (_event, payload: { statePath: string }) => {
    deps.sprintRuntime.unregisterRun(payload.statePath)
    return { ok: true as const }
  })

  ipcMain.handle('sprintengine:runtime:stop-reason', (_event, payload: SprintRuntimeStopReasonPush) => {
    deps.sprintRuntime.applyStopReason(payload)
    return { ok: true as const }
  })
}
