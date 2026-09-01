import { sprintEngineRoleCatalogMaxRoles, sprintEngineRoleSummaryMaxChars, } from '../../../shared/mobile-control/protocol';
import { readSprintEngineRegistryRoles } from '../../sprintengine-artifacts';
// Reading the registry spawns a Python MCP process. Snapshots publish on a ~1s
// throttle and once per workspace, so an uncached read would spawn an interpreter
// per workspace per second — for data that changes when a user edits a JSON file.
// Cache it.
const roleCatalogTtlMs = 60_000;
// A failing read is cached too, and backs off: a desktop with a broken Python
// runtime would otherwise spawn one doomed process per workspace every retry
// window, forever, for a feature that will never succeed there. Back off to a
// ceiling instead, and let a registry write (clearRoleCatalogCache) reset it.
const roleCatalogFailureTtlMs = 10_000;
const roleCatalogFailureTtlCeilingMs = 300_000;
// The read runs on the snapshot publish path, so it must be bounded. Generous —
// a cold Python interpreter on a big workspace is not fast — but finite.
const roleCatalogReadTimeoutMs = 20_000;
const cache = new Map();
const inFlight = new Map();
const consecutiveFailures = new Map();
// A read that was already in flight when the registry changed is reading the *old*
// registry, and must not be allowed to land in the cache afterwards — that would
// pin the pre-change roles for a full TTL. Stamp each read with the generation it
// started in and drop its result if the generation moved under it.
let generation = 0;
/** Drops the cache. Tests, and any surface that has just written a role. */
export function clearRoleCatalogCache() {
    generation += 1;
    cache.clear();
    inFlight.clear();
    consecutiveFailures.clear();
}
// Back off 10s, 20s, 40s… to a 5-minute ceiling while a workspace keeps failing.
function failureTtlMs(workspaceRoot) {
    const failures = consecutiveFailures.get(workspaceRoot) ?? 0;
    return Math.min(roleCatalogFailureTtlMs * 2 ** Math.min(failures, 10), roleCatalogFailureTtlCeilingMs);
}
export const readWorkspaceRoleCatalog = async (workspaceRoot) => {
    const cached = cache.get(workspaceRoot);
    if (cached && cached.expiresAt > Date.now())
        return cached.roles;
    // Concurrent snapshot reads for the same workspace share one process.
    const pending = inFlight.get(workspaceRoot);
    if (pending)
        return pending;
    const startedAt = generation;
    const read = (async () => {
        let roles;
        try {
            // Bounded: this runs on the publish path, and an unbounded read that never
            // settles would pin this very promise in `inFlight` and hand it to every
            // later snapshot — a dead phone until the app restarts.
            const result = await readSprintEngineRegistryRoles({ workspaceRoot }, roleCatalogReadTimeoutMs);
            roles = result.ok ? normalizeRoleCatalog(result.data) : undefined;
        }
        catch {
            // The catalog is an enhancement: a workspace whose registry cannot be read
            // still publishes a snapshot, and the phone falls back to its bundled list.
            roles = undefined;
        }
        if (startedAt === generation) {
            // Read the failure count before bumping it, so the first failure waits the
            // base window rather than already-doubled.
            const ttl = roles ? roleCatalogTtlMs : failureTtlMs(workspaceRoot);
            if (roles) {
                consecutiveFailures.delete(workspaceRoot);
            }
            else {
                consecutiveFailures.set(workspaceRoot, (consecutiveFailures.get(workspaceRoot) ?? 0) + 1);
            }
            cache.set(workspaceRoot, { expiresAt: Date.now() + ttl, roles });
            inFlight.delete(workspaceRoot);
        }
        return roles;
    })();
    inFlight.set(workspaceRoot, read);
    return read;
};
// `sprintengine.roles.list` payload -> wire descriptors. Exported for the tests,
// which drive it with real tool output rather than a hand-built object.
export function normalizeRoleCatalog(input) {
    const rawRoles = isRecord(input) ? input.roles : undefined;
    if (!Array.isArray(rawRoles))
        return undefined;
    const descriptors = [];
    const seen = new Set();
    for (const raw of rawRoles) {
        if (!isRecord(raw))
            continue;
        const roleId = typeof raw.id === 'string' ? raw.id.trim() : '';
        if (!roleId || seen.has(roleId))
            continue;
        seen.add(roleId);
        const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : humanizeRoleId(roleId);
        // MC-1831 renamed the manifest's one-line `summary` to a fuller `description`.
        // The wire field stays `summary` — protocol.ts is a byte-identical mirror of
        // the mobile app's copy — so the picker gets the description, reduced to the
        // same budget. A manifest read by an older engine simply has no description
        // and the picker renders the label alone.
        const summary = typeof raw.description === 'string' ? summarize(raw.description.trim()) : '';
        // MC-1886 removed the sweep concept, so no descriptor carries `sweep` any
        // more. The wire field stays declared in protocol.ts (a byte-identical
        // mirror of the mobile app's copy) for one release, so a phone build that
        // still reads it simply sees an absent key.
        const source = roleSource(raw.source);
        descriptors.push({
            roleId,
            label,
            ...(summary ? { summary } : {}),
            ...(source ? { source } : {}),
        });
        if (descriptors.length >= sprintEngineRoleCatalogMaxRoles)
            break;
    }
    return descriptors;
}
// The user-global registry is mounted as a *plugin* root (`plugin:user-roles`, see
// sprintEngineRegistryRootsForRead), so the raw layer name would tell the phone
// "plugin" for the very roles the user authored themselves. Map it back to what it
// means to a person; other plugin layers collapse to a bare "plugin".
function roleSource(input) {
    const layer = isRecord(input) && typeof input.layer === 'string' ? input.layer.trim() : '';
    if (!layer)
        return undefined;
    if (layer === 'plugin:user-roles')
        return 'user';
    if (layer.startsWith('plugin:'))
        return 'plugin';
    if (layer === 'bundled' || layer === 'workspace' || layer === 'user' || layer === 'plugin')
        return layer;
    return undefined;
}
// Below this a leading "sentence" is an abbreviation ("Ships e.g. ..."), not a
// description of the role, so the hard slice is the honest reduction.
const MIN_LEAD_SENTENCE_CHARS = 40;
// One line for the phone's role picker. A manifest `description` is written as
// "<what the role does>. Staff this role when <situation>." — two sentences that
// together overrun the wire budget for every shipped role, so slicing at the
// budget cut every one of them mid-word ("...the run changes a user-visible
// sc…"). Prefer the leading sentence: it is the one-liner the picker wants and
// it fits with room to spare.
function summarize(value) {
    if (value.length <= sprintEngineRoleSummaryMaxChars)
        return value;
    const lead = /^.*?[.!?](?=\s|$)/u.exec(value)?.[0];
    if (lead && lead.length >= MIN_LEAD_SENTENCE_CHARS && lead.length <= sprintEngineRoleSummaryMaxChars) {
        return lead;
    }
    return `${value.slice(0, sprintEngineRoleSummaryMaxChars - 1).trimEnd()}…`;
}
// Mirrors the phone's roleLabel() fallback, for a manifest with no label.
function humanizeRoleId(roleId) {
    const cleaned = roleId.replace(/[_-]+/gu, ' ').trim();
    if (!cleaned)
        return roleId;
    return cleaned
        .split(/\s+/u)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
