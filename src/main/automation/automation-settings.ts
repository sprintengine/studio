import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Compatibility store for releases that exposed an opt-in automation toggle.
// The SprintEngine Studio MCP gateway is infrastructure and defaults on; the
// service also treats a legacy false value as advisory and remains enabled.

export const AUTOMATION_SETTINGS_FILENAME = 'automation-settings.json'

export type AutomationSettings = { enabled: boolean }

export type AutomationSettingsReadResult = {
  settings: AutomationSettings
  /** Set when the file existed but could not be parsed; the gateway still defaults on. */
  error: string | null
}

export function readAutomationSettings(userDataDir: string): AutomationSettingsReadResult {
  const filePath = join(userDataDir, AUTOMATION_SETTINGS_FILENAME)
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { settings: { enabled: true }, error: null }
    return { settings: { enabled: true }, error: `Could not read ${AUTOMATION_SETTINGS_FILENAME}: ${message(error)}` }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { enabled?: unknown }).enabled !== 'boolean') {
      return {
        settings: { enabled: true },
        error: `${AUTOMATION_SETTINGS_FILENAME} is malformed (expected {"enabled": boolean}); the Studio MCP remains on.`,
      }
    }
    return { settings: { enabled: (parsed as { enabled: boolean }).enabled }, error: null }
  } catch (error) {
    return {
      settings: { enabled: true },
      error: `${AUTOMATION_SETTINGS_FILENAME} is not valid JSON (${message(error)}); the Studio MCP remains on.`,
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
