// Roadmap as a capability module (main side) — MC-1691.
//
// This is intentionally a MANIFEST-ONLY module: it declares Roadmap's identity,
// its trust boundary, and its dependencies to the main-process enablement graph,
// but registers no services or IPC of its own. The roadmap orchestrator is NOT a
// standalone runtime — by decision (D3) it rides the Automations engine's
// evaluation tick, so the automations module both constructs it and gates its
// reconcile on this module's live enablement (see automations-module.ts). Keeping
// a separate registerMain here would need the engine's onEvaluation seam inverted
// (the orchestrator must exist before the engine is created), so the gate lives at
// the tick instead. What this manifest buys: main-side resolution of the `roadmap`
// override + its dependency cascade, which the reconcile gate reads.
//
// `dependsOn` carries BOTH sprint-engine (the roadmap orchestrates sprints) and
// automations (the reconcile rides its tick). The double dependency is what makes
// disabling Automations also disable Roadmap, instead of silently stopping
// reconciliation with the module still showing as on.
export const roadmapModule = {
    manifest: {
        id: 'roadmap',
        displayName: 'Horizon',
        version: 1,
        publisher: 'multicode',
        category: 'orchestration',
        summary: 'Works an ordered plan of backlog items across your projects, one sprint at a time. Disabling hides the sidebar door and stops the orchestrator from starting new sprints.',
        defaultEnabled: true,
        dependsOn: ['sprint-engine', 'automations'],
    },
};
