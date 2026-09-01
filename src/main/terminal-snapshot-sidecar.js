import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
// Durable freeze-the-view: per-terminal snapshot sidecars under
// `<userData>/terminal-snapshots/<sessionId>.json`.
//
// The suspend path (terminal-runtime.suspendTerminal) already builds a faithful
// serialized screen (terminal-replay-snapshot.ts) so a paused agent repaints
// instead of showing black — but that snapshot lives only in the in-memory
// session map, so an app restart loses it and reopening the workspace finds a
// black terminal. These sidecars give that snapshot a disk lifecycle:
//
// - Written at suspend time (serialized snapshot) and at app quit (raw retained
//   pty stream — cheap byte dump; the snapshot is rebuilt lazily on rehydrate).
// - Read on the first terminal-status lookup after restart to materialize a
//   suspended placeholder session, so the existing pause/replay/resume flow
//   fires with zero renderer changes.
// - Removed by disposeTerminal (dispose means gone — never rehydrated) and by
//   the TTL sweep. App-quit teardown deliberately does NOT dispose through
//   disposeTerminal, so quit never erases what it just saved.
//
// Content is whatever was painted on screen, stored in plaintext under
// userData — the same trust boundary as the rest of the app's persisted state
// (accepted in the backlog item).
export const TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME = 'terminal-snapshots';
// Sidecars a month old are painted history nobody has come back for; reclaim
// the disk. Resume/dispose delete them much earlier in the common case.
export const TERMINAL_SNAPSHOT_SIDECAR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Session ids are minted with crypto.randomUUID, but they arrive over IPC — a
// sidecar file name must never be attacker-influenced path material.
function isSafeSessionId(sessionId) {
    return /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && sessionId !== '.' && sessionId !== '..';
}
export function createTerminalSnapshotSidecarStore(options) {
    const ttlMs = options.ttlMs ?? TERMINAL_SNAPSHOT_SIDECAR_TTL_MS;
    const sidecarDir = () => join(options.resolveUserDataDir(), TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME);
    const sidecarPath = (sessionId) => join(sidecarDir(), `${sessionId}.json`);
    const warn = (title, error) => {
        options.logDiagnostic?.({
            level: 'warning',
            title,
            message: 'Terminal snapshot sidecar operation failed.',
            details: error instanceof Error ? error.message : String(error),
        });
    };
    return {
        read(sessionId) {
            if (!isSafeSessionId(sessionId))
                return null;
            let raw;
            try {
                raw = readFileSync(sidecarPath(sessionId), 'utf8');
            }
            catch (error) {
                const code = error?.code;
                if (code !== 'ENOENT')
                    warn('Terminal snapshot sidecar read failed', error);
                return null;
            }
            try {
                const parsed = JSON.parse(raw);
                if (parsed.version !== 1
                    || parsed.sessionId !== sessionId
                    || typeof parsed.savedAt !== 'number'
                    || typeof parsed.cols !== 'number'
                    || typeof parsed.rows !== 'number'
                    || (typeof parsed.snapshot !== 'string' && typeof parsed.rawReplay !== 'string')) {
                    throw new Error('malformed_terminal_snapshot_sidecar');
                }
                return parsed;
            }
            catch (error) {
                warn('Terminal snapshot sidecar parse failed', error);
                return null;
            }
        },
        write(sidecar) {
            if (!isSafeSessionId(sidecar.sessionId))
                return;
            if (!sidecar.snapshot && !sidecar.rawReplay)
                return;
            try {
                const path = sidecarPath(sidecar.sessionId);
                const tmp = `${path}.tmp`;
                mkdirSync(sidecarDir(), { recursive: true });
                writeFileSync(tmp, JSON.stringify(sidecar), { mode: 0o600 });
                renameSync(tmp, path);
            }
            catch (error) {
                warn('Terminal snapshot sidecar write failed', error);
            }
        },
        remove(sessionId) {
            if (!isSafeSessionId(sessionId))
                return;
            try {
                rmSync(sidecarPath(sessionId), { force: true });
            }
            catch (error) {
                warn('Terminal snapshot sidecar remove failed', error);
            }
        },
        sweepExpired(now = Date.now()) {
            let entries;
            try {
                entries = readdirSync(sidecarDir());
            }
            catch (error) {
                const code = error?.code;
                if (code !== 'ENOENT')
                    warn('Terminal snapshot sidecar sweep failed', error);
                return [];
            }
            const removed = [];
            for (const entry of entries) {
                if (!entry.endsWith('.json'))
                    continue;
                const path = join(sidecarDir(), entry);
                try {
                    const age = now - statSync(path).mtimeMs;
                    if (age > ttlMs) {
                        rmSync(path, { force: true });
                        removed.push(entry);
                    }
                }
                catch {
                    // Raced with a concurrent remove/rewrite; the next sweep settles it.
                }
            }
            return removed;
        },
    };
}
