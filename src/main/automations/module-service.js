import { createDefinitionWriteCore, parseDefinitionDraft, parseDefinitionPatch, validateKnownWorkspaceRoot, } from './definition-write';
// Write-core failure codes → the module-facing vocabulary. Draft/config
// problems are the caller's to fix; store misses are not_found; workspace-root
// validation failures are the caller naming a folder the app does not have
// open.
function moduleErrorCode(code) {
    if (code === 'missing')
        return 'not_found';
    if (code === 'not_owner')
        return 'not_owner';
    if (code === 'invalid_input'
        || code === 'unknown_trigger'
        || code === 'unknown_action'
        || code === 'invalid_schedule'
        || code === 'invalid_trigger_config'
        || code === 'provider_blocked'
        || code === 'next_run_unavailable') {
        return 'invalid_draft';
    }
    return 'store_error';
}
function refuse(code, message) {
    return { ok: false, code, message };
}
function refuseFrom(failure) {
    return refuse(moduleErrorCode(failure.code), failure.message);
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function createModuleAutomationsRegistry(deps) {
    const writeCore = createDefinitionWriteCore(deps);
    const subscribers = new Set();
    // Post-write hook failures (webhook receiver refresh) never fail a module
    // write: the record is already persisted, and failing here wedges callers in
    // retry loops against 'already_exists'. Log and move on; schedule-triggered
    // automations do not involve the receiver at all.
    function unwrapWrite(result) {
        if (!result.ok)
            return refuseFrom(result);
        if (result.postWriteFailure) {
            console.warn(`[automations] module write succeeded but the post-write refresh failed: ${result.postWriteFailure.message}`);
        }
        return { ok: true, value: result.value };
    }
    function knownWorkspaceRoot(workspaceRoot) {
        if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
            return refuse('invalid_workspace', 'workspaceRoot is required.');
        }
        // Every validation failure here is about the root, whatever the shared
        // validator's internal code says (invalid_input, workspace_root_untrusted…).
        const validated = validateKnownWorkspaceRoot(workspaceRoot.trim(), deps.getWorkspaceSyncSnapshot);
        if (!validated.ok)
            return refuse('invalid_workspace', validated.message);
        return { ok: true, root: validated.value };
    }
    function ownedBy(moduleId, automationId) {
        return (existing) => existing.ownerModuleId === moduleId
            ? { ok: true }
            : {
                ok: false,
                code: 'not_owner',
                message: `Automation "${automationId}" is not owned by module "${moduleId}".`,
            };
    }
    return {
        async create(moduleId, input) {
            const root = knownWorkspaceRoot(input.workspaceRoot);
            if (!root.ok)
                return root;
            // The parse strips any caller-supplied owner, so check the claim on the
            // raw draft first: echoing your own id is tolerated, claiming another
            // module's identity is refused rather than silently rewritten.
            const claimedOwner = isRecord(input.draft) ? input.draft.ownerModuleId : undefined;
            if (claimedOwner !== undefined && claimedOwner !== moduleId) {
                return refuse('invalid_draft', `Draft ownerModuleId "${String(claimedOwner)}" does not match the calling module "${moduleId}"; omit it — ownership is stamped by the host.`);
            }
            const draft = parseDefinitionDraft(input.draft);
            if (!draft.ok)
                return refuseFrom(draft);
            const created = unwrapWrite(await writeCore.create(root.root, { ...draft.value, ownerModuleId: moduleId }));
            if (!created.ok)
                return created;
            return { ok: true, automation: created.value };
        },
        async update(moduleId, input) {
            const root = knownWorkspaceRoot(input.workspaceRoot);
            if (!root.ok)
                return root;
            const patch = parseDefinitionPatch(input.patch);
            if (!patch.ok)
                return refuseFrom(patch);
            const written = unwrapWrite(await writeCore.update(root.root, input.automationId, patch.value, ownedBy(moduleId, input.automationId)));
            if (!written.ok)
                return written;
            return { ok: true, automation: written.value };
        },
        async delete(moduleId, input) {
            const root = knownWorkspaceRoot(input.workspaceRoot);
            if (!root.ok)
                return root;
            const deleted = unwrapWrite(await writeCore.remove(root.root, input.automationId, ownedBy(moduleId, input.automationId)));
            if (!deleted.ok)
                return deleted;
            return { ok: true };
        },
        async list(moduleId, input) {
            const root = knownWorkspaceRoot(input.workspaceRoot);
            if (!root.ok)
                return root;
            const definitions = await deps.createStore(root.root).listDefinitions();
            if (!definitions.ok) {
                const first = definitions.errors[0];
                return refuse('store_error', first ? `${first.path}: ${first.message}` : 'Automations store is unreadable.');
            }
            return {
                ok: true,
                automations: definitions.values.filter((definition) => definition.ownerModuleId === moduleId),
            };
        },
        async listRuns(moduleId, input) {
            const root = knownWorkspaceRoot(input.workspaceRoot);
            if (!root.ok)
                return root;
            const existing = await writeCore.get(root.root, input.automationId);
            if (!existing.ok)
                return refuseFrom(existing);
            const owned = ownedBy(moduleId, input.automationId)(existing.value);
            if (!owned.ok)
                return refuseFrom(owned);
            const runs = await deps.createStore(root.root).listRuns(input.automationId);
            if (!runs.ok) {
                const first = runs.errors[0];
                return refuse('store_error', first ? `${first.path}: ${first.message}` : 'Run history is unreadable.');
            }
            return { ok: true, runs: runs.values };
        },
        onRunEvent(moduleId, listener) {
            const entry = { moduleId, listener };
            subscribers.add(entry);
            return () => subscribers.delete(entry);
        },
        deliverRunEvent(event, definition) {
            const ownerModuleId = definition.ownerModuleId;
            if (!ownerModuleId)
                return;
            for (const entry of subscribers) {
                if (entry.moduleId !== ownerModuleId)
                    continue;
                try {
                    entry.listener(event);
                }
                catch {
                    // Subscriber delivery is best-effort; run records stay authoritative.
                }
            }
        },
        dispose() {
            subscribers.clear();
        },
    };
}
