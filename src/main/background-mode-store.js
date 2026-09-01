/**
 * Main-owned mirror of the "keep running in the background" setting (MC-2156).
 *
 * Same push contract as the window-material mirror: the renderer owns the
 * preference (`appSettings.keepRunningInBackground`) and pushes it on change;
 * main persists it under userData and reads it **synchronously** — the read
 * happens inside the `window-all-closed` handler, which is exactly the moment
 * there is no renderer left to ask.
 *
 * Absent, unreadable, or malformed all read as OFF. That is not a convenience
 * default: off is byte-for-byte today's behavior, so a store we cannot trust
 * costs the user nothing, while a store that guessed ON would leave a process
 * alive that nobody asked to keep.
 *
 * Deliberately carries no revision counter, unlike the launch-settings record:
 * main never writes this value and never broadcasts it back, so there is no
 * echo to order. The renderer is the only writer.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
const FILE_NAME = 'background-mode.json';
export function createBackgroundModeStore(deps) {
    let cached = null;
    function filePath() {
        return join(deps.resolveUserDataDir(), FILE_NAME);
    }
    return {
        /** The setting the last-window-close decision reads. Never throws. */
        isEnabled() {
            if (cached !== null)
                return cached;
            try {
                const raw = JSON.parse(readFileSync(filePath(), 'utf8'));
                cached =
                    Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
                        ? raw.keepRunningInBackground === true
                        : false;
            }
            catch {
                cached = false;
            }
            return cached;
        },
        /** Adopt a renderer push. Idempotent: an unchanged value never rewrites the file. */
        set(enabled) {
            const next = enabled === true;
            // `isEnabled()` first so the compare is against the persisted value on the
            // very first push of a session, not against an unread cache.
            if (this.isEnabled() === next)
                return;
            cached = next;
            const target = filePath();
            const tmp = `${target}.tmp-${process.pid}`;
            try {
                writeFileSync(tmp, `${JSON.stringify({ keepRunningInBackground: next })}\n`, 'utf8');
                renameSync(tmp, target);
            }
            catch (error) {
                try {
                    unlinkSync(tmp);
                }
                catch {
                    // The temp file may never have been created; nothing to clean up.
                }
                // In-memory still applies for this session, so the user's choice takes
                // effect now — it just will not survive a restart, which is what the
                // warning says.
                deps.logDiagnostic?.({
                    level: 'warning',
                    title: 'Background mode setting not persisted',
                    message: 'The background-mode setting could not be written to disk; it applies for this session but will not survive a restart.',
                    details: error instanceof Error ? error.message : String(error),
                });
            }
        },
    };
}
