// Maps probe outcomes onto the version-control provider contract the renderer
// reads (MC-1995). Kept free of Electron and of the gh runner so the mapping is
// unit-testable without spawning anything; version-control-ipc.ts wires the
// real probes in.
import { VERSION_CONTROL_PROVIDER_IDS, } from '../../shared/version-control';
export async function probeVersionControlProviders(deps) {
    return Promise.all(VERSION_CONTROL_PROVIDER_IDS.map((id) => probeProvider(id, deps)));
}
async function probeProvider(id, deps) {
    const probe = await deps.probeVersion(id);
    if (probe.outcome !== 'resolved')
        return { id, resolved: false, reason: probe.outcome };
    // git has no auth of its own to report; only gh does.
    if (id !== 'gh')
        return { id, resolved: true, version: probe.version };
    const login = await deps.readGhLogin();
    return login
        ? { id, resolved: true, version: probe.version, auth: { login } }
        : { id, resolved: true, version: probe.version };
}
// Reads the login out of `gh auth status`. gh has printed this line two ways
// ("Logged in to <host> as <login>" before v2.40, "… account <login>" after),
// and gh has moved the report between stdout and stderr across versions, so
// callers pass both streams. The first login reported wins; gh lists the active
// host first. Only the login is extracted — the token gh masks in the same
// report is never read.
export function parseGhAuthLogin(output) {
    const match = /Logged in to \S+ (?:account|as) ([^\s(]+)/.exec(output);
    return match ? match[1] : null;
}
