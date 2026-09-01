import { addOrUpdateBacklogLink, markProxyBacklogItemUnavailable, materializeProxyBacklogItem, } from '../../backlog-service';
import { toTrackerError, TrackerProviderError, } from '../../../shared/tracker/types';
import { composeProxyBody, proxyIssueLink, trackerProviderLabel } from './proxy-content';
const MATERIALIZE_FETCH_CONCURRENCY = 12;
export async function materializeTrackerIssues(input) {
    const connectionId = input.connectionId;
    let connection;
    try {
        connection = await input.tracker.getConnection(connectionId);
    }
    catch (err) {
        return { ok: false, error: toTrackerError(err, { connectionId }) };
    }
    if (!connection) {
        return {
            ok: false,
            error: toTrackerError(new TrackerProviderError('not_configured', 'This tracker connection no longer exists.', { connectionId }), {
                connectionId,
            }),
        };
    }
    // De-dupe requested ids so the same issue is never fetched or written twice in
    // one pass; blanks are dropped.
    const externalIds = dedupe(input.externalIds);
    const providerLabel = trackerProviderLabel(connection.provider);
    // Phase 1: fetch concurrently (network-bound) into a position-indexed array,
    // preserving per-issue error isolation.
    const outcomes = await mapWithConcurrency(externalIds, MATERIALIZE_FETCH_CONCURRENCY, async (externalId) => {
        const result = await input.tracker.fetchIssue({ connectionId, externalId });
        if (result.ok)
            return { kind: 'issue', externalId, issue: result.issue };
        // A genuinely missing issue (404) is a deleted upstream, handled distinctly
        // from a transient failure so an existing proxy is marked unavailable rather
        // than dropped or falsely refreshed.
        if (result.error.kind === 'not_found')
            return { kind: 'deleted', externalId };
        return { kind: 'failed', externalId, reason: result.error.message };
    });
    // Phase 2: apply writes sequentially — one materialize touches the item file
    // and the shared sidecar, so serializing avoids a lost-update race.
    let added = 0;
    let refreshed = 0;
    const failed = [];
    for (const outcome of outcomes) {
        if (outcome.kind === 'issue') {
            const written = await landProxyItem(input.workspaceRoot, outcome.issue, connection);
            if (!written.ok) {
                failed.push({ externalId: outcome.externalId, reason: written.message });
            }
            else if (written.outcome === 'added') {
                added += 1;
            }
            else {
                refreshed += 1;
            }
            continue;
        }
        if (outcome.kind === 'deleted') {
            const marked = await markProxyBacklogItemUnavailable({
                workspaceRoot: input.workspaceRoot,
                connectionId,
                externalId: outcome.externalId,
                providerLabel,
                reason: `No longer available in ${providerLabel}.`,
            });
            if (!marked.ok) {
                failed.push({ externalId: outcome.externalId, reason: marked.message });
            }
            else if (marked.found) {
                // An existing proxy visibly flipped to unavailable is a refresh, not a
                // failure — the item stays, honestly marked.
                refreshed += 1;
            }
            else {
                failed.push({ externalId: outcome.externalId, reason: `Not found in ${providerLabel}.` });
            }
            continue;
        }
        failed.push({ externalId: outcome.externalId, reason: outcome.reason });
    }
    return { ok: true, added, refreshed, failed };
}
// Write the proxy file, then upsert its single issue-typed sidecar link. The
// link is applied after the file exists so it attaches to the item's stable
// relative path; a failed link write surfaces as this issue's failure reason.
async function landProxyItem(workspaceRoot, issue, connection) {
    const written = await materializeProxyBacklogItem({
        workspaceRoot,
        provider: issue.provider,
        connectionId: connection.id,
        externalId: issue.externalId,
        externalKey: issue.nativeKey,
        externalUrl: issue.url,
        title: issue.title,
        body: composeProxyBody(issue),
    });
    if (!written.ok)
        return { ok: false, message: written.message };
    const linked = await addOrUpdateBacklogLink({
        workspaceRoot,
        relativePath: written.relativePath,
        link: proxyIssueLink(issue),
    });
    if (!linked.ok)
        return { ok: false, message: linked.message };
    return { ok: true, outcome: written.outcome };
}
function dedupe(ids) {
    const seen = new Set();
    const out = [];
    for (const raw of ids ?? []) {
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}
// Bounded-concurrency map preserving input order, mirroring the renderer's
// backlog scan pool (src/renderer/src/utils/backlog.ts): a shared cursor hands
// each worker the next index, results land position-indexed.
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const run = async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length)
                return;
            results[index] = await worker(items[index]);
        }
    };
    const workerCount = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => run()));
    return results;
}
