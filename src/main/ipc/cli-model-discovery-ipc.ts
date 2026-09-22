import { BrowserWindow, type IpcMain } from 'electron'

import {
  CLI_MODELS_CHANGED_CHANNEL,
  CLI_MODELS_DISCOVER_CHANNEL,
  type CliModelDiscoveryInput,
  type CliModelDiscoveryResult,
} from '../../shared/ipc/cli-model-discovery'
import { isRecord } from '../../shared/records'
import { discoverCliModels } from '../model-discovery/service'

type WindowLike = { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }

export type CliModelDiscoveryIpcDeps = {
  discover?: (input: CliModelDiscoveryInput) => Promise<CliModelDiscoveryResult>
  getWindows?: () => WindowLike[]
}

// Runs a discovery pass and pushes every catalog a probe actually produced to
// every window, so a window that did not ask (a second window, or any window
// when the pass came from main at boot or after an install) still updates its
// pickers. A skipped or failed CLI is not pushed: there is nothing new to store.
export async function discoverAndBroadcastCliModels(
  input: CliModelDiscoveryInput = {},
  deps: CliModelDiscoveryIpcDeps = {},
): Promise<CliModelDiscoveryResult> {
  const result = await (deps.discover ?? discoverCliModels)(input)
  const produced = result.entries.filter((entry) => entry.catalog && !entry.skipped)
  if (produced.length > 0) {
    const payload: CliModelDiscoveryResult = { ...result, entries: produced }
    const windows = (deps.getWindows ?? (() => BrowserWindow.getAllWindows()))()
    for (const win of windows) {
      if (!win.isDestroyed()) win.webContents.send(CLI_MODELS_CHANGED_CHANNEL, payload)
    }
  }
  return result
}

// The renderer sends what it holds; anything that is not the declared shape is
// dropped here rather than trusted into the probe plumbing.
function readInput(raw: unknown): CliModelDiscoveryInput {
  if (!isRecord(raw)) return {}
  const input: CliModelDiscoveryInput = {}
  if (isRecord(raw.cliRuntimes)) input.cliRuntimes = raw.cliRuntimes as CliModelDiscoveryInput['cliRuntimes']
  if (Array.isArray(raw.clis)) input.clis = raw.clis.filter((cli): cli is string => typeof cli === 'string')
  if (raw.force === true) input.force = true
  if (isRecord(raw.previous)) input.previous = raw.previous as CliModelDiscoveryInput['previous']
  return input
}

export function registerCliModelDiscoveryIpc(ipcMain: IpcMain, deps: CliModelDiscoveryIpcDeps = {}): void {
  ipcMain.handle(CLI_MODELS_DISCOVER_CHANNEL, (_event, raw?: unknown): Promise<CliModelDiscoveryResult> =>
    discoverAndBroadcastCliModels(readInput(raw), deps),
  )
}
