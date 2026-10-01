import type { IpcMain } from 'electron'

import type {
  AgentLaunchPreviewInput,
  AgentLaunchPreviewResult,
  PluginAvailabilityResult,
  PluginDetectAvailabilityInput,
  PluginRegistryListResult,
} from '../../shared/electron-api'
import { renderAgentLaunchPreview } from '../agent-launch-render'
import { detectAgentCliAvailability } from '../cli-availability'
import { getPluginManifest, listPluginRegistryEntries } from '../plugin-registry-instance'
import { permissionRenderKey } from '../plugin-render'

export type PluginIpcHandlers = {
  list(): PluginRegistryListResult
  detectAvailability(input: PluginDetectAvailabilityInput | undefined): Promise<PluginAvailabilityResult>
  launchPreview(input: AgentLaunchPreviewInput | undefined): AgentLaunchPreviewResult
}

function createPluginIpcHandlers(): PluginIpcHandlers {
  return {
    list(): PluginRegistryListResult {
      try {
        return { ok: true, plugins: listPluginRegistryEntries() }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    async detectAvailability(input: PluginDetectAvailabilityInput | undefined): Promise<PluginAvailabilityResult> {
      try {
        return { ok: true, availability: await detectAgentCliAvailability(input) }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    // The launch surface's receipt line. Rendered in main because the
    // renderer's plugin catalog deliberately withholds argv — and rendered
    // through the spawn's own function, so the line cannot drift from what a
    // launch would do.
    launchPreview(input: AgentLaunchPreviewInput | undefined): AgentLaunchPreviewResult {
      if (!input?.cli) return { ok: false, message: 'No agent CLI selected.' }
      try {
        const { cliPermissionMode, ...rest } = input
        const preset = rest.cliPermissionPreset
        return {
          ok: true,
          preview: renderAgentLaunchPreview({
            ...rest,
            ...(preset
              ? { cliPermissionPreset: permissionRenderKey(getPluginManifest(input.cli), preset, cliPermissionMode) }
              : {}),
          }),
        }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  }
}

export function registerPluginIpc(ipcMain: IpcMain, overrides: Partial<PluginIpcHandlers> = {}): void {
  const handlers: PluginIpcHandlers = { ...createPluginIpcHandlers(), ...overrides }

  ipcMain.handle('plugins:list', async (): Promise<PluginRegistryListResult> => {
    try {
      return handlers.list()
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'plugins:detect-availability',
    async (_event, input: PluginDetectAvailabilityInput | undefined): Promise<PluginAvailabilityResult> => {
      try {
        return await handlers.detectAvailability(input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'plugins:launch-preview',
    async (_event, input: AgentLaunchPreviewInput | undefined): Promise<AgentLaunchPreviewResult> => {
      try {
        return handlers.launchPreview(input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
