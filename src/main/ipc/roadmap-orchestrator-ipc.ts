// IPC surface for the roadmap orchestrator, consumed by the steering board
// (MC-1620 / T7): read lane state, and the three human steering actions —
// approve the next start, merge a delivered lane, resume a parked lane. All
// mutations are authenticated main-process calls; the renderer never touches run
// or roadmap state directly. The preload bridge + renderer wiring belong to the
// surface task; these handlers are the seam it invokes.

import type { IpcMain } from 'electron'

import type { RoadmapOrchestrator, RoadmapView } from '../roadmap-orchestrator'

export const ROADMAP_STATES_READ_CHANNEL = 'roadmap:states:read'
export const ROADMAP_LANE_APPROVE_CHANNEL = 'roadmap:lane:approve'
export const ROADMAP_LANE_MERGE_CHANNEL = 'roadmap:lane:merge'
export const ROADMAP_LANE_RESUME_CHANNEL = 'roadmap:lane:resume'
export const ROADMAP_LANE_PAUSE_CHANNEL = 'roadmap:lane:pause'

export type RoadmapStatesReadPayload = { workspaceRoot: string }
export type RoadmapLaneCommandPayload = { workspaceRoot: string; roadmapRef: string; lane: string }
export type RoadmapCommandResult = { ok: boolean; message?: string }
export type RoadmapStatesReadResult = { ok: true; roadmaps: RoadmapView[] } | { ok: false; message: string }

export function registerRoadmapOrchestratorIpc(ipcMain: IpcMain, orchestrator: RoadmapOrchestrator): void {
  ipcMain.handle(
    ROADMAP_STATES_READ_CHANNEL,
    async (_event, payload: RoadmapStatesReadPayload): Promise<RoadmapStatesReadResult> => {
      try {
        const roadmaps = await orchestrator.readRoadmapStates(payload.workspaceRoot)
        return { ok: true, roadmaps }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    ROADMAP_LANE_APPROVE_CHANNEL,
    async (_event, payload: RoadmapLaneCommandPayload): Promise<RoadmapCommandResult> =>
      orchestrator.approveStart(payload.workspaceRoot, payload.roadmapRef, payload.lane),
  )

  ipcMain.handle(
    ROADMAP_LANE_MERGE_CHANNEL,
    async (_event, payload: RoadmapLaneCommandPayload): Promise<RoadmapCommandResult> =>
      orchestrator.mergeLane(payload.workspaceRoot, payload.roadmapRef, payload.lane),
  )

  ipcMain.handle(
    ROADMAP_LANE_RESUME_CHANNEL,
    async (_event, payload: RoadmapLaneCommandPayload): Promise<RoadmapCommandResult> =>
      orchestrator.resumeLane(payload.workspaceRoot, payload.roadmapRef, payload.lane),
  )

  ipcMain.handle(
    ROADMAP_LANE_PAUSE_CHANNEL,
    async (_event, payload: RoadmapLaneCommandPayload): Promise<RoadmapCommandResult> =>
      orchestrator.pauseLane(payload.workspaceRoot, payload.roadmapRef, payload.lane),
  )
}
