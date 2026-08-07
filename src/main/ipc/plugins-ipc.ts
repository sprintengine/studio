import type { IpcMain } from 'electron'

import type {
  AgentLaunchPreviewInput,
  AgentLaunchPreviewResult,
  PluginAvailabilityResult,
  PluginDetectAvailabilityInput,
  PluginInstallResult,
  PluginRegistryListResult,
} from '../../shared/electron-api'
import { renderAgentLaunchPreview } from '../agent-launch-render'
import { detectAgentCliAvailability } from '../cli-availability'
import { installPluginFolder } from '../plugin-install'
import {
  getPluginRegistryUserRoot,
  listPluginRegistryEntries,
  reloadPluginRegistry,
} from '../plugin-registry-instance'

export type PluginIpcHandlers = {
  list(): PluginRegistryListResult
  detectAvailability(input: PluginDetectAvailabilityInput | undefined): Promise<PluginAvailabilityResult>
  installFolder(srcDir: unknown): Promise<PluginInstallResult>
  reload(): PluginRegistryListResult
  launchPreview(input: AgentLaunchPreviewInput | undefined): AgentLaunchPreviewResult
}

export function createPluginIpcHandlers(): PluginIpcHandlers {
  return {
    list(): PluginRegistryListResult {
      try {
        return { ok: true, plugins: listPluginRegistryEntries() }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    async detectAvailability(
      input: PluginDetectAvailabilityInput | undefined,
    ): Promise<PluginAvailabilityResult> {
      try {
        return { ok: true, availability: await detectAgentCliAvailability(input) }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    async installFolder(srcDir: unknown): Promise<PluginInstallResult> {
      if (typeof srcDir !== 'string' || srcDir.trim().length === 0) {
        return { ok: false, message: 'No folder selected.' }
      }
      try {
        const installed = await installPluginFolder(srcDir, getPluginRegistryUserRoot())
        if (!installed.ok) return installed
        // Pick the new plugin up immediately so the renderer's next list reflects it.
        reloadPluginRegistry()
        return { ok: true, id: installed.id, kind: installed.kind, displayName: installed.displayName }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    reload(): PluginRegistryListResult {
      try {
        reloadPluginRegistry()
        return { ok: true, plugins: listPluginRegistryEntries() }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    // The launch surface's receipt line (MC-2147). Rendered in main because the
    // renderer's plugin catalog deliberately withholds argv — and rendered
    // through the spawn's own function, so the line cannot drift from what a
    // launch would do.
    launchPreview(input: AgentLaunchPreviewInput | undefined): AgentLaunchPreviewResult {
      if (!input?.cli) return { ok: false, message: 'No agent CLI selected.' }
      try {
        return { ok: true, preview: renderAgentLaunchPreview(input) }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  }
}

export function registerPluginIpc(
  ipcMain: IpcMain,
  overrides: Partial<PluginIpcHandlers> = {}
): void {
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
    'plugins:install-folder',
    async (_event, srcDir: unknown): Promise<PluginInstallResult> => {
      try {
        return await handlers.installFolder(srcDir)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    }
  )

  ipcMain.handle('plugins:reload', async (): Promise<PluginRegistryListResult> => {
    try {
      return handlers.reload()
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

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
