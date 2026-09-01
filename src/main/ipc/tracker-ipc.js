import { resolveConnectionSampleIssue } from '../tracker/connection-sample-issue';
import { materializeTrackerIssues } from '../tracker/materialize/materialize-service';
import { getSharedTrackerService } from '../tracker/tracker-service';
import { getSharedTrackerWriteBackConfigStore } from '../tracker/writeback/config-store';
import { getSharedTrackerWriteBackLedger } from '../tracker/writeback/ledger';
import { normalizeTrackerWriteBackConfig, } from '../../shared/tracker/writeback';
import { toTrackerError, } from '../../shared/tracker/types';
function defaultWriteBackDeps() {
    const store = getSharedTrackerWriteBackConfigStore();
    return {
        getConfig: (connectionId) => store.get(connectionId),
        setConfig: (connectionId, config) => store.set(connectionId, config),
        resolveSampleIssue: (workspaceRoot, connectionId) => resolveConnectionSampleIssue(workspaceRoot, connectionId),
    };
}
// The real, reconcile-backed binding: the app wires this from the process-wide
// write-back runtime so "Retry now" genuinely re-posts (register-core-ipc).
export function createTrackerWriteBackNoticeDeps(runtime) {
    return {
        listNotices: () => runtime.ledger.listNotices(),
        retryConnection: (connectionId) => runtime.retryConnectionNotices(connectionId),
    };
}
// Fallback for a registration without the write-back runtime (the direct IPC unit
// test injects its own). Listing reads the shared ledger — the same store the
// runtime posts through — so it is honest; retry can't reconcile without the
// engine, so it only re-reads the connection's current notices.
function defaultWriteBackNoticeDeps() {
    const ledger = getSharedTrackerWriteBackLedger();
    return {
        listNotices: () => ledger.listNotices(),
        retryConnection: async (connectionId) => (await ledger.listNotices()).filter((notice) => notice.connectionId === connectionId),
    };
}
function defaultMaterializeHandler(input) {
    const service = getSharedTrackerService();
    return materializeTrackerIssues({
        ...input,
        tracker: {
            getConnection: (id) => service.connections.getConnection(id),
            fetchIssue: (fetchInput) => service.fetchIssue(fetchInput),
        },
    });
}
export function registerTrackerIpc(ipcMain, service = getSharedTrackerService(), materialize = defaultMaterializeHandler, writeBack = defaultWriteBackDeps(), writeBackNotices = defaultWriteBackNoticeDeps()) {
    ipcMain.handle('tracker:listConnections', () => {
        return service.listConnections();
    });
    ipcMain.handle('tracker:addConnection', (_event, input) => {
        return service.addConnection(input);
    });
    ipcMain.handle('tracker:removeConnection', (_event, input) => {
        return service.removeConnection(input);
    });
    ipcMain.handle('tracker:testConnection', (_event, input) => {
        return service.testConnection(input);
    });
    ipcMain.handle('tracker:search', (_event, input) => {
        return service.search(input);
    });
    ipcMain.handle('tracker:fetchIssue', (_event, input) => {
        return service.fetchIssue(input);
    });
    ipcMain.handle('tracker:materialize', (_event, input) => {
        return materialize(input);
    });
    // Write-back config round-trips the T10 schema (no secret). The store normalizes
    // on read and write, so a malformed blob degrades to the opt-in default rather
    // than corrupting the engine's gating.
    ipcMain.handle('tracker:getWriteBackConfig', async (_event, input) => {
        try {
            return { ok: true, config: await writeBack.getConfig(input.connectionId) };
        }
        catch (err) {
            return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) };
        }
    });
    ipcMain.handle('tracker:setWriteBackConfig', async (_event, input) => {
        try {
            await writeBack.setConfig(input.connectionId, normalizeTrackerWriteBackConfig(input.config));
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) };
        }
    });
    // Enumerate a connection's status transitions from a REAL issue it already owns
    // in this workspace. No local issue ⇒ an honest empty list with `no_sample_issue`
    // (the UI asks the user to add one first); a provider without `canTransition`
    // ⇒ `unsupported`. Auth/network failures surface as ok:false so the UI shows the
    // real reason rather than a silently empty picker.
    ipcMain.handle('tracker:listTransitions', async (_event, input) => {
        let sample;
        try {
            sample = await writeBack.resolveSampleIssue(input.workspaceRoot, input.connectionId);
        }
        catch (err) {
            return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) };
        }
        if (!sample)
            return { ok: true, transitions: [], sampleKey: null, reason: 'no_sample_issue' };
        const result = await service.listTransitions({ connectionId: input.connectionId, externalId: sample.externalId });
        if (!result.ok) {
            if (result.error.kind === 'unsupported') {
                return { ok: true, transitions: [], sampleKey: sample.nativeKey, reason: 'unsupported' };
            }
            return { ok: false, error: result.error };
        }
        return { ok: true, transitions: result.transitions, sampleKey: sample.nativeKey };
    });
    // Write-back failure notices (T18): the failures the engine records but nothing
    // used to read. The settings surface lists them and offers a real retry —
    // re-running reconcile for the connection's stuck runs now — so an expired token
    // is visible and recoverable instead of silently posting nothing forever.
    ipcMain.handle('tracker:listWriteBackNotices', async () => {
        try {
            return { ok: true, notices: await writeBackNotices.listNotices() };
        }
        catch (err) {
            return { ok: false, error: toTrackerError(err) };
        }
    });
    ipcMain.handle('tracker:retryWriteBack', async (_event, input) => {
        try {
            return { ok: true, notices: await writeBackNotices.retryConnection(input.connectionId) };
        }
        catch (err) {
            return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) };
        }
    });
}
