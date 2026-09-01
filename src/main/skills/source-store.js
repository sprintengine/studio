// Where the user's skill sources live.
//
// Sources are app-level, not workspace-level: a repository you added is a
// repository you added, and re-adding it in every workspace would be busywork.
// Installing is the workspace-level half — see install.ts. They persist in
// userData next to the GitHub token, and each source's scan result is cached
// beside it so reopening a source costs nothing and Sync is the only refresh.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILTIN_SKILL_SOURCE_ID, CONNECTORS_SKILL_SOURCE_ID, } from '../../shared/skills';
const FILE_NAME = 'skill-sources.json';
/** The two sources every install has, which cannot be removed. */
export const ALWAYS_PRESENT_SKILL_SOURCES = [
    {
        id: BUILTIN_SKILL_SOURCE_ID,
        kind: 'builtin',
        name: 'Multicode',
        repo: '',
        monogram: 'MC',
        blurb: 'The skills Multicode ships.',
        commitSha: '',
        scannedAt: '',
    },
    {
        id: CONNECTORS_SKILL_SOURCE_ID,
        kind: 'connectors',
        name: 'Connectors',
        repo: '',
        monogram: 'CO',
        blurb: 'Skills published by the tools you connect to.',
        commitSha: '',
        scannedAt: '',
    },
];
export function isRemovableSkillSource(id) {
    return !ALWAYS_PRESENT_SKILL_SOURCES.some((source) => source.id === id);
}
export function createSkillSourceStore(userDataDir) {
    const path = join(userDataDir, FILE_NAME);
    const read = async () => {
        try {
            return parseSkillSourceState(await readFile(path, 'utf8'));
        }
        catch {
            return emptyState();
        }
    };
    // Serialized read-modify-write: adding two sources in quick succession must
    // not lose one to a stale in-memory copy.
    let writeChain = Promise.resolve();
    const update = async (mutate) => {
        const run = writeChain.then(async () => {
            const state = await read();
            if (!mutate(state))
                return false;
            await mkdir(userDataDir, { recursive: true });
            const temp = `${path}.tmp`;
            await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
            await rename(temp, path);
            return true;
        });
        writeChain = run.catch(() => undefined);
        return run;
    };
    return {
        async listSources() {
            const state = await read();
            return [...ALWAYS_PRESENT_SKILL_SOURCES, ...state.sources];
        },
        async getSource(id) {
            const always = ALWAYS_PRESENT_SKILL_SOURCES.find((source) => source.id === id);
            if (always)
                return always;
            const state = await read();
            return state.sources.find((source) => source.id === id) ?? null;
        },
        async putSource(source, scan) {
            await update((state) => {
                const index = state.sources.findIndex((existing) => existing.id === source.id);
                if (index === -1)
                    state.sources.push(source);
                else
                    state.sources[index] = source;
                if (scan)
                    state.scans[source.id] = scan;
                else
                    delete state.scans[source.id];
                return true;
            });
        },
        async removeSource(id) {
            if (!isRemovableSkillSource(id))
                return false;
            return update((state) => {
                const index = state.sources.findIndex((source) => source.id === id);
                if (index === -1)
                    return false;
                state.sources.splice(index, 1);
                delete state.scans[id];
                return true;
            });
        },
        async getScan(id) {
            const state = await read();
            return state.scans[id] ?? null;
        },
        async hasAdoptedLegacyPacks() {
            return (await read()).adoptedLegacyPacks;
        },
        async markLegacyPacksAdopted() {
            await update((state) => {
                if (state.adoptedLegacyPacks)
                    return false;
                state.adoptedLegacyPacks = true;
                return true;
            });
        },
    };
}
/**
 * A malformed or partly-unreadable store degrades to "no user sources" rather
 * than throwing: the always-present sources still list, and re-adding a
 * repository is one paste.
 */
export function parseSkillSourceState(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return emptyState();
    }
    if (!parsed || typeof parsed !== 'object')
        return emptyState();
    const record = parsed;
    const sources = Array.isArray(record.sources)
        ? record.sources.filter(isPersistableSource).filter((source) => isRemovableSkillSource(source.id))
        : [];
    const scans = {};
    if (record.scans && typeof record.scans === 'object' && !Array.isArray(record.scans)) {
        for (const [id, scan] of Object.entries(record.scans)) {
            if (isPersistableScan(scan))
                scans[id] = scan;
        }
    }
    return { sources, scans, adoptedLegacyPacks: record.adoptedLegacyPacks === true };
}
function emptyState() {
    return { sources: [], scans: {}, adoptedLegacyPacks: false };
}
function isPersistableSource(value) {
    if (!value || typeof value !== 'object')
        return false;
    const source = value;
    return (typeof source.id === 'string'
        && source.id.length > 0
        && source.kind === 'github'
        && typeof source.repo === 'string'
        && typeof source.name === 'string');
}
function isPersistableScan(value) {
    if (!value || typeof value !== 'object')
        return false;
    const scan = value;
    return Array.isArray(scan.skills) && Array.isArray(scan.groups);
}
