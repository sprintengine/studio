import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// The automation server is off by default; enabling it is an explicit,
// persisted user setting owned by the main process (the server must know the
// setting before any renderer exists). Stored as a small JSON file in userData.

export const AUTOMATION_SETTINGS_FILENAME = 'automation-settings.json'

export type AutomationSettings = { enabled: boolean }

export type AutomationSettingsReadResult = {
  settings: AutomationSettings
  /** Set when the file existed but could not be parsed — read fails closed. */
  error: string | null
}

export function readAutomationSettings(userDataDir: string): AutomationSettingsReadResult {
  const filePath = join(userDataDir, AUTOMATION_SETTINGS_FILENAME)
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { settings: { enabled: false }, error: null }
    return { settings: { enabled: false }, error: `Could not read ${AUTOMATION_SETTINGS_FILENAME}: ${message(error)}` }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { enabled?: unknown }).enabled !== 'boolean') {
      return {
        settings: { enabled: false },
        error: `${AUTOMATION_SETTINGS_FILENAME} is malformed (expected {"enabled": boolean}); automation stays off.`,
      }
    }
    return { settings: { enabled: (parsed as { enabled: boolean }).enabled }, error: null }
  } catch (error) {
    return {
      settings: { enabled: false },
      error: `${AUTOMATION_SETTINGS_FILENAME} is not valid JSON (${message(error)}); automation stays off.`,
    }
  }
}

export function writeAutomationSettings(userDataDir: string, settings: AutomationSettings): void {
  const filePath = join(userDataDir, AUTOMATION_SETTINGS_FILENAME)
  writeFileSync(filePath, `${JSON.stringify({ enabled: settings.enabled }, null, 2)}\n`, { mode: 0o600 })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
