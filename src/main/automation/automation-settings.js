import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
// Compatibility store for releases that exposed an opt-in automation toggle.
// The SprintEngine Studio MCP gateway is infrastructure and defaults on; the
// service also treats a legacy false value as advisory and remains enabled.
export const AUTOMATION_SETTINGS_FILENAME = 'automation-settings.json';
export function readAutomationSettings(userDataDir) {
    const filePath = join(userDataDir, AUTOMATION_SETTINGS_FILENAME);
    let raw;
    try {
        raw = readFileSync(filePath, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return { settings: { enabled: true }, error: null };
        return { settings: { enabled: true }, error: `Could not read ${AUTOMATION_SETTINGS_FILENAME}: ${message(error)}` };
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.enabled !== 'boolean') {
            return {
                settings: { enabled: true },
                error: `${AUTOMATION_SETTINGS_FILENAME} is malformed (expected {"enabled": boolean}); the Studio MCP remains on.`,
            };
        }
        return { settings: { enabled: parsed.enabled }, error: null };
    }
    catch (error) {
        return {
            settings: { enabled: true },
            error: `${AUTOMATION_SETTINGS_FILENAME} is not valid JSON (${message(error)}); the Studio MCP remains on.`,
        };
    }
}
export function writeAutomationSettings(userDataDir, settings) {
    const filePath = join(userDataDir, AUTOMATION_SETTINGS_FILENAME);
    writeFileSync(filePath, `${JSON.stringify({ enabled: settings.enabled }, null, 2)}\n`, { mode: 0o600 });
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
