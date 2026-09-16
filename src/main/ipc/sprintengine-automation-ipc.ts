import type { IpcInvokeHandler } from '../module-host/main-host'
import type {
  SprintEngineAutomationHydrateInput,
  SprintEngineAutomationReadInput,
  SprintEngineAutomationSetModeInput,
  SprintEngineCliPermissionPresetSetInput,
} from '../../shared/sprintengine/ipc-types'
import { SPRINT_ENGINE_CHANNELS, SPRINT_ENGINE_EVENTS } from '../../shared/sprintengine/ipc-channels'
import type { SprintEngineAutomationService } from '../sprintengine-automation-service'
import type { SprintEngineLaunchSettingsMirror } from '../sprintengine-launch-settings-mirror'
import type { SprintEngineAutomationChangedEvent } from '../../shared/sprintengine/ipc-types'

export const SPRINT_ENGINE_AUTOMATION_CHANGED_CHANNEL = 'sprintengine:automation-changed'

export type SprintEngineAutomationIpcHost = {
  registerIpc(channel: string, handler: IpcInvokeHandler): void
}

type SprintEngineAutomationIpcDependencies = {
  automation: Pick<
    SprintEngineAutomationService,
    'readAutomationMode' | 'setAutomationMode' | 'hydrateAutomationMode' | 'setCliPermissionPreset'
  >
  launchSettings: Pick<SprintEngineLaunchSettingsMirror, 'set' | 'hydrate'>
}

type AutomationChangedEmit = (event: SprintEngineAutomationChangedEvent) => void

let automationChangedEmit: AutomationChangedEmit | null = null

export function bindSprintEngineAutomationChangedEmit(emit: AutomationChangedEmit | null): void {
  automationChangedEmit = emit
}

export function deliverSprintEngineAutomationChanged(event: SprintEngineAutomationChangedEvent): void {
  automationChangedEmit?.(event)
}

export function registerSprintEngineAutomationIpc(
  host: SprintEngineAutomationIpcHost,
  deps: SprintEngineAutomationIpcDependencies,
): void {
  host.registerIpc(SPRINT_ENGINE_CHANNELS.automationRead, (_event, payload: unknown) => {
    return deps.automation.readAutomationMode(payload as SprintEngineAutomationReadInput)
  })

  // The renderer writer is always `ui`: the actor names the process boundary
  // the write came through, not the human. Mobile writes come in through the
  // relay command service (never this channel) as `mobile`.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.automationSetMode, (_event, payload: unknown) => {
    return deps.automation.setAutomationMode({ ...(payload as SprintEngineAutomationSetModeInput), actor: 'ui' })
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.automationHydrate, (_event, payload: unknown) => {
    return deps.automation.hydrateAutomationMode(payload as SprintEngineAutomationHydrateInput)
  })

  // MC-1799: the CLI permission preset shares the mode's statePath-keyed home,
  // so the Sprints door can set it without a resident workspace. Same actor
  // rule as set-mode: this channel is the renderer boundary.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.automationSetPermissionPreset, (_event, payload: unknown) => {
    return deps.automation.setCliPermissionPreset({
      ...(payload as SprintEngineCliPermissionPresetSetInput),
      actor: 'ui',
    })
  })

  // MC-2154: the renderer pushes the launch settings it authors (cliRuntimes,
  // mcp, knowledge roots, last-selected CLI, spawn permission preset, rosters)
  // so main can compose a launch with no window open. Payload is normalized
  // fail-soft; the returned revision is what the pusher reconciles against.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.launchSettingsSync, (_event, payload: unknown) => {
    const result = deps.launchSettings.set(payload)
    return { ok: true as const, record: result.record, changed: result.changed }
  })

  // First-boot seed: adopted only when main holds no record yet, so a restart
  // never lets a window re-assert settings over main's own.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.launchSettingsHydrate, (_event, payload: unknown) => {
    const result = deps.launchSettings.hydrate(payload)
    return { ok: true as const, record: result.record, changed: result.changed }
  })
}

export { SPRINT_ENGINE_EVENTS }
