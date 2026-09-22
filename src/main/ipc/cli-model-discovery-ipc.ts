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
  // The CLI command and WSL overrides a pass runs with when its caller sends
  // none; defaults to the resolver app-services installs (below).
  mainCliRuntimes?: () => CliModelDiscoveryInput['cliRuntimes']
}

// A pass that main starts on its own — the boot pass, the pass after an install
// — has no window to hand it the person's per-CLI command and WSL overrides.
// Those settings are authored in the renderer, but main keeps its own persisted
// mirror of them (launch-settings-mirror.ts) for exactly this kind of headless
// path, and app-services points this resolver at it. Without it a boot pass on a
// Windows machine with a CLI installed both natively and in WSL would probe the
// native one and serve its list for a day.
let resolveMainCliRuntimes: (() => CliModelDiscoveryInput['cliRuntimes']) | null = null

export function setCliModelDiscoveryRuntimesResolver(
  resolver: (() => CliModelDiscoveryInput['cliRuntimes']) | null,
): void {
  resolveMainCliRuntimes = resolver
}

function withMainCliRuntimes(
  input: CliModelDiscoveryInput,
  resolve: (() => CliModelDiscoveryInput['cliRuntimes']) | null,
): CliModelDiscoveryInput {
  if (input.cliRuntimes) return input
  let cliRuntimes: CliModelDiscoveryInput['cliRuntimes']
  try {
    cliRuntimes = resolve?.()
  } catch {
    cliRuntimes = undefined
  }
  return cliRuntimes && Object.keys(cliRuntimes).length > 0 ? { ...input, cliRuntimes } : input
}

// Runs a discovery pass and pushes every catalog a probe actually produced to
// every window, so a window that did not ask (a second window, or any window
// when the pass came from main at boot or after an install) still updates its
// pickers. A skipped or failed CLI is not pushed: there is nothing new to store.
export async function discoverAndBroadcastCliModels(
  input: CliModelDiscoveryInput = {},
  deps: CliModelDiscoveryIpcDeps = {},
): Promise<CliModelDiscoveryResult> {
  const result = await (deps.discover ?? discoverCliModels)(
    withMainCliRuntimes(input, deps.mainCliRuntimes ?? resolveMainCliRuntimes),
  )
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
