/**
 * Main-owned store for the app's agent-launch settings (MC-2154; shapes and
 * record math in `src/shared/sprintengine/launch-settings.ts`).
 *
 * The settings are authored in the renderer (`appSettings`, localStorage) and
 * pushed here on change (`sprintengine:launch-settings:sync`); main persists
 * them under userData and reads them **synchronously** at spawn time, so the
 * headless paths — the main scheduler, boot-time run discovery, a mobile
 * launch — compose a launch with the user's real CLI, permission preset, MCP
 * servers, and rosters with zero windows open, across an app restart.
 *
 * Writes are atomic (tmp + rename) and carry a monotonic revision plus write
 * provenance; a content-identical push is an idempotent no-op (no bump, no
 * subscriber wake), so the renderer's push-on-any-store-change never churns
 * the file. `hydrate` seeds the store exactly once — the first boot after this
 * landed, or a fresh install — and never overwrites an existing record.
 *
 * Writer model: the renderer is the only writer today, so there is no
 * apply-back into `appSettings`; a broadcast would be a second source of truth
 * for values the renderer already owns. The revision and `subscribe` seam are
 * what a future main-side writer (the agent-launch service) needs to become
 * authoritative without a schema change.
 */
import { readFileSync } from 'fs';
import { mkdir, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { emptySprintEngineLaunchSettings, nextSprintEngineLaunchSettingsRecord, normalizeSprintEngineLaunchSettings, parseSprintEngineLaunchSettingsRecord, serializeSprintEngineLaunchSettingsRecord, sprintEngineLaunchSettingsEqual, } from '../shared/sprintengine/launch-settings';
const FILE_NAME = 'sprintengine-launch-settings.json';
export function createSprintEngineLaunchSettingsMirror(deps) {
    const now = deps.now ?? (() => Date.now());
    let current = null;
    // The pre-MC-2154 file held bare settings with no revision. It is readable
    // but not authoritative: reads use it so the first boot after upgrade still
    // spawns with the user's runtimes, while hydration/first push replaces it
    // with a real record.
    let legacySettings = null;
    let loadedFromDisk = false;
    const listeners = new Set();
    function filePath() {
        return join(deps.resolveUserDataDir(), FILE_NAME);
    }
    /**
     * Synchronous read-through of the persisted record. Null means no
     * authoritative record exists yet (absent, corrupt, or the legacy bare
     * settings file) — hydration seeds one.
     */
    function loadOnce() {
        if (loadedFromDisk)
            return current;
        loadedFromDisk = true;
        try {
            const raw = JSON.parse(readFileSync(filePath(), 'utf8'));
            current = parseSprintEngineLaunchSettingsRecord(raw);
            if (!current && raw && typeof raw === 'object' && !Array.isArray(raw)) {
                legacySettings = normalizeSprintEngineLaunchSettings(raw);
            }
        }
        catch {
            current = null;
        }
        return current;
    }
    // Writes serialize behind one another and each gets its own temp file: two
    // pushes in the same tick would otherwise race on a shared temp path and
    // could land the older revision last.
    let writeQueue = Promise.resolve();
    let writeSequence = 0;
    function persist(record) {
        const attempt = ++writeSequence;
        const settled = writeQueue.then(async () => {
            const target = filePath();
            const tmp = `${target}.tmp-${process.pid}-${attempt}`;
            try {
                await mkdir(dirname(target), { recursive: true });
                await writeFile(tmp, serializeSprintEngineLaunchSettingsRecord(record), 'utf8');
                await rename(tmp, target);
            }
            catch (error) {
                await unlink(tmp).catch(() => undefined);
                deps.logDiagnostic?.({
                    level: 'warning',
                    title: 'Agent launch settings not persisted',
                    message: 'The launch settings could not be written to disk; in-memory values still apply until the app restarts.',
                    details: error instanceof Error ? error.message : String(error),
                });
            }
        });
        writeQueue = settled;
        return settled;
    }
    function commit(settings, actor) {
        const record = nextSprintEngineLaunchSettingsRecord({
            current: loadOnce(),
            settings,
            actor,
            now: now(),
        });
        current = record;
        legacySettings = null;
        const persisted = persist(record);
        for (const listener of listeners)
            listener(settings);
        return { record, changed: true, persisted };
    }
    return {
        /** The settings main spawns with. Never throws: an absent store reads as defaults. */
        get() {
            return loadOnce()?.settings ?? legacySettings ?? emptySprintEngineLaunchSettings();
        },
        /** The authoritative record, or null when nothing has been written yet. */
        getRecord() {
            return loadOnce();
        },
        /**
         * Adopt a renderer push. A content-identical push is a no-op: no revision
         * bump, no write, no subscriber wake — the renderer pushes on every store
         * change, and an unchanged blob is not a new revision.
         */
        set(raw) {
            const settings = normalizeSprintEngineLaunchSettings(raw);
            const existing = loadOnce();
            if (existing && sprintEngineLaunchSettingsEqual(existing.settings, settings)) {
                return { record: existing, changed: false, persisted: Promise.resolve() };
            }
            return commit(settings, 'ui');
        },
        /**
         * One-time seed from the renderer's persisted settings, for the first boot
         * after this store landed (or a fresh install). No-op once a record
         * exists: main's record is authoritative from then on, and the renderer
         * reconciles against it rather than re-asserting.
         */
        hydrate(raw) {
            const existing = loadOnce();
            if (existing)
                return { record: existing, changed: false, persisted: Promise.resolve() };
            return commit(normalizeSprintEngineLaunchSettings(raw), 'system');
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
