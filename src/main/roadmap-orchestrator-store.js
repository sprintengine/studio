// Crash-safe persistence for the roadmap orchestrator's only durable state: the
// per-lane runtime (active run ref, parked reason, pending approval). Everything
// else re-derives from backlog + run records on restart, so this store is small
// and its loss degrades to "re-derive from scratch", never to a wrong conclusion.
//
// INSTANCE-GLOBAL (MC-1688): the roadmap is one plan per Multicode, so its runtime
// lives in a SINGLE instance store rooted at the designated HOME PROJECT (D1) —
// `<homeRoot>/.multi-code/sprintengine/roadmaps/<slug>.json`, beside the roadmap
// file. Older builds let ANY project carry roadmaps, each with its own per-project
// sidecar at the SAME relative path; `read` absorbs the first such legacy sidecar
// found under a NON-home root into the home store ONCE and deletes every legacy
// copy, so a kill/restart after the upgrade re-derives the same state.
//
// Writes are atomic (tmp + rename) and serialized per roadmap, mirroring
// `sprintengine-automation-service.ts`'s sidecar discipline; a malformed or
// missing file reads as empty rather than throwing.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const ROADMAP_RUNTIME_SCHEMA_VERSION = 1;
const ROADMAP_RUNTIME_DIR = ['.multi-code', 'sprintengine', 'roadmaps'];
const PARK_REASONS = new Set([
    'run_failed',
    'run_canceled',
    'needs_input',
    'pr_closed',
    'merge_failed',
    'start_failed',
    'eligibility_contradiction',
    'unknown_project',
    'paused',
]);
// The sidecar path for a roadmap under a project root, keyed by its file-name stem
// so two roadmaps never collide. `queueKey` is the resolved path so aliases share
// one write queue. The instance store passes the home root; a legacy sweep passes
// a non-home root (same relative path).
export function roadmapRuntimePath(baseDir, roadmapRef) {
    const slug = roadmapSlug(roadmapRef);
    const path = join(baseDir, ...ROADMAP_RUNTIME_DIR, `${slug}.json`);
    return { path, queueKey: resolve(path) };
}
function roadmapSlug(roadmapRef) {
    const name = roadmapRef.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? roadmapRef;
    const stem = name.replace(/\.md$/i, '');
    // Contain the slug to a single safe path segment — a roadmap ref is authored
    // input; dot segments and separators must not escape the runtime dir.
    return stem.replace(/[^a-zA-Z0-9._-]/g, '_') || 'roadmap';
}
// The single instance store. `baseDir` is the home project root (D1); the roadmap
// runtime lives beside the roadmap file under `<homeRoot>/.multi-code/...`.
export function createRoadmapOrchestratorStore(baseDir) {
    const writeQueues = new Map();
    function enqueue(queueKey, task) {
        const tail = writeQueues.get(queueKey) ?? Promise.resolve();
        const next = tail.then(task, task);
        const settled = next.catch(() => undefined);
        writeQueues.set(queueKey, settled);
        void settled.then(() => {
            if (writeQueues.get(queueKey) === settled)
                writeQueues.delete(queueKey);
        });
        return next;
    }
    // Read the roadmap's lane runtime. `legacyRoots`, when supplied, are NON-home
    // workspace roots to sweep for a pre-instance sidecar: if the home store has no
    // record yet, the first legacy sidecar found is absorbed and every legacy copy
    // deleted, so the migration runs exactly once.
    async function read(roadmapRef, legacyRoots = []) {
        const { path, queueKey } = roadmapRuntimePath(baseDir, roadmapRef);
        return enqueue(queueKey, async () => {
            const existing = await readRecord(path);
            if (existing)
                return normalizeLanes(existing);
            if (legacyRoots.length === 0)
                return new Map();
            return absorbLegacy(path, roadmapRef, legacyRoots);
        });
    }
    async function write(roadmapRef, lanes) {
        const { path, queueKey } = roadmapRuntimePath(baseDir, roadmapRef);
        const record = {
            schemaVersion: ROADMAP_RUNTIME_SCHEMA_VERSION,
            roadmapRef,
            lanes: [...lanes.values()].map(normalizeLane).filter((lane) => lane !== null),
        };
        await enqueue(queueKey, () => writeRecord(path, record));
    }
    // Absorb the first legacy per-project sidecar into the instance store, then
    // delete every legacy copy (best-effort). Returns the absorbed lanes, or empty
    // when no legacy sidecar exists.
    async function absorbLegacy(instancePath, roadmapRef, legacyRoots) {
        let absorbed = null;
        for (const root of legacyRoots) {
            const legacyPath = roadmapRuntimePath(root, roadmapRef).path;
            if (legacyPath === instancePath)
                continue; // never sweep the home store itself.
            const record = await readRecord(legacyPath);
            if (record && !absorbed)
                absorbed = normalizeLanes(record);
            await unlink(legacyPath).catch(() => undefined);
        }
        if (!absorbed)
            return new Map();
        await writeRecord(instancePath, {
            schemaVersion: ROADMAP_RUNTIME_SCHEMA_VERSION,
            roadmapRef,
            lanes: [...absorbed.values()],
        }).catch(() => undefined);
        return absorbed;
    }
    return { read, write };
}
async function readRecord(path) {
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch {
        return null;
    }
    return safeParse(raw);
}
async function writeRecord(path, record) {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    try {
        await rename(tmpPath, path);
    }
    catch (error) {
        await unlink(tmpPath).catch(() => undefined);
        throw error;
    }
}
function safeParse(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function normalizeLanes(parsed) {
    const out = new Map();
    if (!isRecord(parsed) || !Array.isArray(parsed.lanes))
        return out;
    for (const raw of parsed.lanes) {
        const lane = normalizeLane(raw);
        if (lane)
            out.set(lane.lane, lane);
    }
    return out;
}
// Field-by-field tolerant validation: an unknown or corrupt lane record is
// dropped, never read as a live run. The runtime is bookkeeping — dropping a bad
// row degrades to re-derivation, so a strict schema would be worse than lenient.
function normalizeLane(raw) {
    if (!isRecord(raw) || typeof raw.lane !== 'string' || raw.lane.length === 0)
        return null;
    const lane = { lane: raw.lane };
    if (typeof raw.activeItemRef === 'string')
        lane.activeItemRef = raw.activeItemRef;
    if (typeof raw.activeStatePath === 'string')
        lane.activeStatePath = raw.activeStatePath;
    if (typeof raw.activeTeamSlug === 'string')
        lane.activeTeamSlug = raw.activeTeamSlug;
    if (typeof raw.activeRepoId === 'string')
        lane.activeRepoId = raw.activeRepoId;
    if (typeof raw.pendingApprovalRef === 'string')
        lane.pendingApprovalRef = raw.pendingApprovalRef;
    if (isRecord(raw.parked) && typeof raw.parked.itemRef === 'string' && isParkReason(raw.parked.reason)) {
        lane.parked = {
            reason: raw.parked.reason,
            itemRef: raw.parked.itemRef,
            at: typeof raw.parked.at === 'string' ? raw.parked.at : '',
            ...(typeof raw.parked.detail === 'string' ? { detail: raw.parked.detail } : {}),
        };
    }
    return lane;
}
function isParkReason(value) {
    return typeof value === 'string' && PARK_REASONS.has(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
