import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter';
import { runRelativePathForStatePath, safeProjectRelativeRunPath, sprintEngineRunLinkOf, } from '../../../shared/backlog/sprintengine-links';
import { readBacklogObjectStore } from '../../backlog-service';
const PROVIDERS = new Set(['github', 'jira', 'linear']);
export function createProxyItemLookup(deps = defaultDeps()) {
    return {
        async proxyItemsForRun({ workspaceRoot, statePath }) {
            const runRelativePath = runRelativePathForStatePath(workspaceRoot, statePath);
            if (!runRelativePath)
                return [];
            const read = await deps.readObjectStore(workspaceRoot);
            if (!read.ok)
                return [];
            const items = [];
            for (const record of read.store.items) {
                const links = record.links ?? [];
                const runLink = sprintEngineRunLinkOf(links);
                if (!runLink)
                    continue;
                const linkPath = safeProjectRelativeRunPath(runLink.target.path ?? '');
                if (!linkPath || linkPath !== runRelativePath)
                    continue;
                const identity = await readExternalIdentity(deps, workspaceRoot, record.source.relativePath);
                if (!identity)
                    continue;
                items.push({ relativePath: record.source.relativePath, ...identity });
            }
            return items;
        },
    };
}
async function readExternalIdentity(deps, workspaceRoot, relativePath) {
    const fields = await deps.readItemFrontmatter(workspaceRoot, relativePath);
    if (!fields)
        return null;
    // A proxy whose upstream issue is gone would 404 on a post; skip it rather than
    // manufacture a failure notice for a deleted issue.
    if (typeof fields.external_unavailable === 'string' && fields.external_unavailable.trim())
        return null;
    const provider = fields.external_provider?.trim();
    const connectionId = fields.external_connection?.trim();
    const externalId = fields.external_id?.trim();
    if (!provider || !PROVIDERS.has(provider) || !connectionId || !externalId)
        return null;
    return {
        provider: provider,
        connectionId,
        externalId,
        nativeKey: fields.external_key?.trim() || externalId,
    };
}
function defaultDeps() {
    return {
        readObjectStore: (workspaceRoot) => readBacklogObjectStore(workspaceRoot),
        readItemFrontmatter: async (workspaceRoot, relativePath) => {
            let raw;
            try {
                raw = await readFile(join(workspaceRoot, relativePath), 'utf-8');
            }
            catch {
                return null;
            }
            return parseBacklogFrontmatter(raw).fields;
        },
    };
}
