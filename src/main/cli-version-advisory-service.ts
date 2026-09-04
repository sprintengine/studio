// The app-wide CLI version check: detect what is installed, ask the registries,
// and tell every window when the answer changed. IPC (a Settings re-check) and
// the poller both come through here so they share the npm cache and the
// enabled flag the Settings switch mirrors into main.
import { BrowserWindow } from 'electron'

import type { CliVersionAdvisoriesInput, CliVersionAdvisoriesResult, CliVersionAdvisoryMap } from '../shared/electron-api'
import { detectAgentCliAvailability } from './cli-availability'
import { resolveCliVersionAdvisories } from './cli-version-advisory'
import { getPluginManifest } from './plugin-registry-instance'

export const CLI_VERSION_ADVISORIES_CHANGED_CHANNEL = 'cli-version:advisories-changed'

let enabled = true
let lastAdvisories: CliVersionAdvisoryMap | null = null

export function setCliVersionChecksEnabled(next: boolean): boolean {
  enabled = next
  return enabled
}

export function cliVersionChecksEnabled(): boolean {
  return enabled
}

export function resetCliVersionAdvisoryServiceForTests(): void {
  enabled = true
  lastAdvisories = null
}

export type CliVersionAdvisoryBroadcast = (result: CliVersionAdvisoriesResult) => void

const defaultBroadcast: CliVersionAdvisoryBroadcast = (result) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CLI_VERSION_ADVISORIES_CHANGED_CHANNEL, result)
  }
}

// What the toast and the bell key on: the set of (cli, latestVersion) pairs
// that are behind. Two reads with the same pairs are the same answer.
function outdatedSignature(advisories: CliVersionAdvisoryMap): string {
  return Object.values(advisories)
    .filter((entry) => entry?.status === 'behind_latest')
    .map((entry) => `${entry!.cli}@${entry!.latestVersion}`)
    .sort()
    .join('\n')
}

export async function readCliVersionAdvisories(
  input: CliVersionAdvisoriesInput = {},
  options: { broadcast?: CliVersionAdvisoryBroadcast; notify?: boolean } = {},
): Promise<CliVersionAdvisoriesResult> {
  if (!enabled && !input.force) {
    return { ok: true, advisories: {}, checkedAt: new Date().toISOString() }
  }
  try {
    const availability = await detectAgentCliAvailability({ cliRuntimes: input.cliRuntimes })
    const advisories = await resolveCliVersionAdvisories(availability, {
      getManifest: (cli) => getPluginManifest(cli),
      force: input.force === true,
    })
    const result: CliVersionAdvisoriesResult = { ok: true, advisories, checkedAt: new Date().toISOString() }
    const changed = lastAdvisories === null || outdatedSignature(lastAdvisories) !== outdatedSignature(advisories)
    lastAdvisories = advisories
    if (changed && options.notify !== false) (options.broadcast ?? defaultBroadcast)(result)
    return result
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
