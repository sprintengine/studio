// IPC surface for the roadmap orchestrator, consumed by the steering board
// (MC-1620 / T7): read lane state, and the three human steering actions —
// approve the next start, merge a delivered lane, resume a parked lane. All
// mutations are authenticated main-process calls; the renderer never touches run
// or roadmap state directly. The preload bridge + renderer wiring belong to the
// surface task; these handlers are the seam it invokes.
export const ROADMAP_STATES_READ_CHANNEL = 'roadmap:states:read';
export const ROADMAP_LANE_APPROVE_CHANNEL = 'roadmap:lane:approve';
export const ROADMAP_LANE_MERGE_CHANNEL = 'roadmap:lane:merge';
export const ROADMAP_LANE_RESUME_CHANNEL = 'roadmap:lane:resume';
export const ROADMAP_LANE_PAUSE_CHANNEL = 'roadmap:lane:pause';
export const ROADMAP_HOME_GET_CHANNEL = 'roadmap:home:get';
export const ROADMAP_HOME_SET_CHANNEL = 'roadmap:home:set';
// The three plan-file mutations the steering surface drives, each a single atomic
// main-process op (MC-1718): activate a draft as the one active roadmap, skip a step
// off the active plan, and create a new draft roadmap.
export const ROADMAP_ACTIVATE_CHANNEL = 'roadmap:activate';
export const ROADMAP_SKIP_STEP_CHANNEL = 'roadmap:step:skip';
export const ROADMAP_CREATE_CHANNEL = 'roadmap:create';
// Delete a horizon file (MC-1917). The plan only — never the backlog items it lines
// up, and never the runs it already started.
export const ROADMAP_DELETE_CHANNEL = 'roadmap:delete';
export function registerRoadmapOrchestratorIpc(ipcMain, orchestrator, home) {
    ipcMain.handle(ROADMAP_HOME_GET_CHANNEL, async () => ({ path: home.getHomeProjectPath() }));
    ipcMain.handle(ROADMAP_HOME_SET_CHANNEL, async (_event, payload) => {
        try {
            await home.setHomeProjectPath(payload.path);
            await orchestrator.reconcile();
            return { ok: true };
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle(ROADMAP_STATES_READ_CHANNEL, async () => {
        try {
            const roadmaps = await orchestrator.readRoadmapStates();
            return { ok: true, roadmaps };
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle(ROADMAP_LANE_APPROVE_CHANNEL, async (_event, payload) => orchestrator.approveStart(payload.roadmapRef, payload.lane));
    ipcMain.handle(ROADMAP_LANE_MERGE_CHANNEL, async (_event, payload) => orchestrator.mergeLane(payload.roadmapRef, payload.lane));
    ipcMain.handle(ROADMAP_LANE_RESUME_CHANNEL, async (_event, payload) => orchestrator.resumeLane(payload.roadmapRef, payload.lane, 'user', {
        replanDeliveredRun: payload.replanDeliveredRun === true,
    }));
    ipcMain.handle(ROADMAP_LANE_PAUSE_CHANNEL, async (_event, payload) => orchestrator.pauseLane(payload.roadmapRef, payload.lane));
    ipcMain.handle(ROADMAP_ACTIVATE_CHANNEL, async (_event, payload) => orchestrator.activateRoadmap({ roadmapRef: payload.roadmapRef }));
    ipcMain.handle(ROADMAP_DELETE_CHANNEL, async (_event, payload) => orchestrator.deleteRoadmap({ roadmapRef: payload.roadmapRef }));
    ipcMain.handle(ROADMAP_SKIP_STEP_CHANNEL, async (_event, payload) => orchestrator.skipStep({ ref: payload.ref, reason: payload.reason, actor: 'user' }));
    // Create is the one command that also touches the home-project setting: a brand-new
    // roadmap in a Multicode with no home adopts its project as the home (D1). The write
    // and the home-set run as one op, then a reconcile picks up the new home.
    ipcMain.handle(ROADMAP_CREATE_CHANNEL, async (_event, payload) => {
        try {
            const hadHome = home.getHomeProjectPath() !== null;
            const created = await orchestrator.createRoadmap({ projectRoot: payload.projectRoot, name: payload.name });
            if (!created.ok)
                return created;
            if (!hadHome)
                await home.setHomeProjectPath(created.projectRoot);
            await orchestrator.reconcile();
            return { ok: true, roadmapRef: created.roadmapRef };
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    });
}
