// Enumerate every automation across every known project root with the live state
// the Automations surface rail draws. A root whose definitions cannot be read is
// recorded as a problem and skipped (never masking the roots that DO read); a
// single automation whose run history is unreadable still lists (definition +
// null last run) with its own problem recorded — the definition existing is not
// in doubt, only its runs. Roots and definitions come out in a stable order
// (project-folder order, then definition id) so the rail render is deterministic.
export async function buildAutomationsInstanceIndex(ports) {
    const mapDefinition = ports.mapDefinition ?? ((definition) => definition);
    const entries = [];
    const problems = [];
    for (const folder of ports.projectFolders) {
        const store = ports.createStore(folder.folderPath);
        const definitions = await store.listDefinitions();
        if (!definitions.ok) {
            problems.push({ workspaceRoot: folder.folderPath, message: firstProblemMessage(definitions.errors) });
            continue;
        }
        for (const definition of definitions.values) {
            const runs = await store.listRuns(definition.id);
            if (!runs.ok) {
                problems.push({ workspaceRoot: folder.folderPath, message: firstProblemMessage(runs.errors) });
                entries.push({
                    workspaceRoot: folder.folderPath,
                    workspaceId: folder.workspaceId,
                    definition: mapDefinition(definition),
                    lastRun: null,
                    isRunningNow: false,
                });
                continue;
            }
            // listRuns returns newest-first, so [0] is the last run and a run in the
            // running state (agent-backed runs stay `running` until finalize) sorts to
            // the front — but check the whole (bounded) history for `running` so a
            // stray ordering never hides an in-flight run.
            entries.push({
                workspaceRoot: folder.folderPath,
                workspaceId: folder.workspaceId,
                definition: mapDefinition(definition),
                lastRun: runs.values[0] ?? null,
                isRunningNow: runs.values.some((run) => run.status === 'running'),
            });
        }
    }
    return { entries, problems };
}
function firstProblemMessage(errors) {
    const [first] = errors;
    if (!first)
        return 'Automations store operation failed.';
    if (errors.length === 1)
        return first.message;
    return `${errors.length} automations store files are malformed or unreadable.`;
}
