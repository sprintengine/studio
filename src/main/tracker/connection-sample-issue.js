import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBacklogFrontmatter } from '../../shared/backlog/frontmatter';
import { readBacklogObjectStore } from '../backlog-service';
export async function resolveConnectionSampleIssue(workspaceRoot, connectionId, deps = defaultDeps()) {
    if (!workspaceRoot || !connectionId)
        return null;
    const read = await deps.readObjectStore(workspaceRoot);
    if (!read.ok)
        return null;
    for (const record of read.store.items) {
        const fields = await deps.readItemFrontmatter(workspaceRoot, record.source.relativePath);
        if (!fields)
            continue;
        if (fields.external_connection?.trim() !== connectionId)
            continue;
        if (typeof fields.external_unavailable === 'string' && fields.external_unavailable.trim())
            continue;
        const externalId = fields.external_id?.trim();
        if (!externalId)
            continue;
        return { externalId, nativeKey: fields.external_key?.trim() || externalId };
    }
    return null;
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
