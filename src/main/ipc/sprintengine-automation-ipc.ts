import type { IpcMain } from 'electron'
import type {
  SprintEngineAutomationHydrateInput,
  SprintEngineAutomationReadInput,
  SprintEngineAutomationSetModeInput,
  SprintEngineCliPermissionPresetSetInput,
} from '../../shared/electron-api'
import type { SprintEngineAutomationService } from '../sprintengine-automation-service'
import type { SprintEngineLaunchSettingsMirror } from '../sprintengine-launch-settings-mirror'

export const SPRINT_ENGINE_AUTOMATION_CHANGED_CHANNEL = 'sprintengine:automation-changed'

type SprintEngineAutomationIpcDependencies = {
  automation: Pick<
    SprintEngineAutomationService,
    'readAutomationMode' | 'setAutomationMode' | 'hydrateAutomationMode' | 'setCliPermissionPreset'
  >
  launchSettings: Pick<SprintEngineLaunchSettingsMirror, 'set' | 'hydrate'>
}

export function registerSprintEngineAutomationIpc(
  ipcMain: IpcMain,
  deps: SprintEngineAutomationIpcDependencies,
): void {
  ipcMain.handle('sprintengine:automation:read', (_event, payload: SprintEngineAutomationReadInput) => {
    return deps.automation.readAutomationMode(payload)
  })

  // The renderer writer is always `ui`: the actor names the process boundary
  // the write came through, not the human. Mobile writes come in through the
  // relay command service (never this channel) as `mobile`.
  ipcMain.handle('sprintengine:automation:set-mode', (_event, payload: SprintEngineAutomationSetModeInput) => {
    return deps.automation.setAutomationMode({ ...payload, actor: 'ui' })
  })

  ipcMain.handle('sprintengine:automation:hydrate', (_event, payload: SprintEngineAutomationHydrateInput) => {
    return deps.automation.hydrateAutomationMode(payload)
  })

  // MC-1799: the CLI permission preset shares the mode's statePath-keyed home,
  // so the Sprints door can set it without a resident workspace. Same actor
  // rule as set-mode: this channel is the renderer boundary.
  ipcMain.handle(
    'sprintengine:automation:set-permission-preset',
    (_event, payload: SprintEngineCliPermissionPresetSetInput) => {
      return deps.automation.setCliPermissionPreset({ ...payload, actor: 'ui' })
    },
  )

  // MC-2154: the renderer pushes the launch settings it authors (cliRuntimes,
  // mcp, knowledge roots, last-selected CLI, spawn permission preset, rosters)
  // so main can compose a launch with no window open. Payload is normalized
  // fail-soft; the returned revision is what the pusher reconciles against.
  ipcMain.handle('sprintengine:launch-settings:sync', (_event, payload: unknown) => {
    const result = deps.launchSettings.set(payload)
    return { ok: true as const, record: result.record, changed: result.changed }
  })

  // First-boot seed: adopted only when main holds no record yet, so a restart
  // never lets a window re-assert settings over main's own.
  ipcMain.handle('sprintengine:launch-settings:hydrate', (_event, payload: unknown) => {
    const result = deps.launchSettings.hydrate(payload)
    return { ok: true as const, record: result.record, changed: result.changed }
  })
}
