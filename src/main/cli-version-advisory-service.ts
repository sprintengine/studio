// The app-wide CLI version check: detect what is installed, ask the registries,
// and tell every window when the answer changed. IPC (a Settings re-check) and
// the poller both come through here so they share the npm cache and the
// enabled flag the Settings switch mirrors into main.
import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  CliVersionAdvisoriesInput,
  CliVersionAdvisoriesResult,
  CliVersionAdvisory,
  CliVersionAdvisoryMap,
} from '../shared/electron-api'
import { detectAgentCliAvailability } from './cli-availability'
import { outdatedClis, resolveCliVersionAdvisories } from './cli-version-advisory'
import { getPluginManifest } from './plugin-registry-instance'

export const CLI_VERSION_ADVISORIES_CHANGED_CHANNEL = 'cli-version:advisories-changed'

let enabled = true
let lastAdvisories: CliVersionAdvisoryMap | null = null

// The (cli, latestVersion) pairs this install has already announced with a
// toast, on disk so a restart does not repeat them. Test seam: the path.
export const CLI_UPDATE_NOTICES_FILENAME = 'cli-update-notices.json'
let noticesPath: string | null = null
let announced: Set<string> | null = null

export function setCliUpdateNoticesPathForTests(path: string | null): void {
  noticesPath = path
  announced = null
}

function resolveNoticesPath(): string {
  if (noticesPath) return noticesPath
  noticesPath = join(app.getPath('userData'), CLI_UPDATE_NOTICES_FILENAME)
  return noticesPath
}

async function loadAnnounced(): Promise<Set<string>> {
  if (announced) return announced
  try {
    const parsed = JSON.parse(await readFile(resolveNoticesPath(), 'utf8')) as unknown
    announced = new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch {
    announced = new Set()
  }
  return announced
}

async function saveAnnounced(set: Set<string>): Promise<void> {
  try {
    const path = resolveNoticesPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify([...set].sort(), null, 2)}\n`, 'utf8')
  } catch {
    // Losing the file only means one repeated toast after a restart.
  }
}

const pairKey = (advisory: CliVersionAdvisory): string => `${advisory.cli}@${advisory.latestVersion ?? ''}`

// Outdated CLIs not yet announced at this version; records them as announced.
export async function takeNewlyOutdated(advisories: CliVersionAdvisoryMap): Promise<CliVersionAdvisory[]> {
  const seen = await loadAnnounced()
  const fresh = outdatedClis(advisories).filter((advisory) => !seen.has(pairKey(advisory)))
  if (fresh.length > 0) {
    for (const advisory of fresh) seen.add(pairKey(advisory))
    await saveAnnounced(seen)
  }
  return fresh
}

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
  announced = null
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
    const newlyOutdated = await takeNewlyOutdated(advisories)
    const result: CliVersionAdvisoriesResult = {
      ok: true,
      advisories,
      checkedAt: new Date().toISOString(),
      ...(newlyOutdated.length > 0 ? { newlyOutdated } : {}),
    }
    const changed =
      newlyOutdated.length > 0 ||
      lastAdvisories === null ||
      outdatedSignature(lastAdvisories) !== outdatedSignature(advisories)
    lastAdvisories = advisories
    if (changed && options.notify !== false) (options.broadcast ?? defaultBroadcast)(result)
    return result
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
