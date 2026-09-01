import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { DEFAULT_TRACKER_WRITEBACK_CONFIG, normalizeTrackerWriteBackConfig, trackerWriteBackConfigIsActive, } from '../../../shared/tracker/writeback';
const FILE_NAME = 'tracker-writeback-config.json';
export class TrackerWriteBackConfigStore {
    resolveUserDataDir;
    files;
    byConnection = null;
    constructor(options = {}) {
        this.resolveUserDataDir = options.resolveUserDataDir ?? (() => loadElectron().app.getPath('userData'));
        this.files = options.files ?? { mkdir, readFile, writeFile, rename };
    }
    // The effective config for a connection: its stored value normalized, or the
    // opt-in default when it has none. Always returns a complete, safe config.
    async get(connectionId) {
        const map = await this.ensureLoaded();
        const stored = map[connectionId];
        return stored ? normalizeTrackerWriteBackConfig(stored) : { ...DEFAULT_TRACKER_WRITEBACK_CONFIG };
    }
    // The full per-connection map (for the T11 settings surface). Normalized copies.
    async list() {
        const map = await this.ensureLoaded();
        const out = {};
        for (const [id, config] of Object.entries(map))
            out[id] = normalizeTrackerWriteBackConfig(config);
        return out;
    }
    async set(connectionId, config) {
        const map = await this.ensureLoaded();
        map[connectionId] = normalizeTrackerWriteBackConfig(config);
        await this.persist(map);
    }
    // Drop a connection's config when the connection is removed, so a re-used id
    // never inherits a prior connection's write-back settings.
    async remove(connectionId) {
        const map = await this.ensureLoaded();
        if (!(connectionId in map))
            return;
        delete map[connectionId];
        await this.persist(map);
    }
    // Cheap engine gate: does ANY connection have active write-back? Lets the
    // engine skip the backlog scan entirely when write-back is off everywhere,
    // preserving zero-connection byte-identical behavior.
    async anyActive() {
        const map = await this.ensureLoaded();
        return Object.values(map).some((config) => trackerWriteBackConfigIsActive(normalizeTrackerWriteBackConfig(config)));
    }
    async ensureLoaded() {
        if (this.byConnection)
            return this.byConnection;
        this.byConnection = await this.read();
        return this.byConnection;
    }
    async read() {
        let raw;
        try {
            raw = (await this.files.readFile(this.storePath(), 'utf8'));
        }
        catch {
            return {}; // No file yet ⇒ no config ⇒ byte-identical to today.
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.byConnection !== 'object' || parsed.byConnection === null)
                return {};
            const out = {};
            for (const [id, config] of Object.entries(parsed.byConnection)) {
                out[id] = normalizeTrackerWriteBackConfig(config);
            }
            return out;
        }
        catch {
            return {};
        }
    }
    async persist(map) {
        const payload = { version: 1, byConnection: map };
        const path = this.storePath();
        const tmp = `${path}.tmp`;
        await this.files.mkdir(dirname(path), { recursive: true });
        await this.files.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
        await this.files.rename(tmp, path);
    }
    storePath() {
        return join(this.resolveUserDataDir(), FILE_NAME);
    }
}
function loadElectron() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron');
}
// Process-wide config-store singleton. The write-back engine (via
// createTrackerWriteBackRuntime) and the T11 IPC surface MUST share ONE instance:
// the store caches `byConnection` in memory, so a save through a second instance
// would leave the engine reconciling against a stale cache until restart. Tests
// that inject `resolveUserDataDir` construct their own isolated instance instead.
let sharedConfigStore = null;
export function getSharedTrackerWriteBackConfigStore() {
    return (sharedConfigStore ??= new TrackerWriteBackConfigStore());
}
