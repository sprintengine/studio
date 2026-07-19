// Builds the read-only roadmap progress riders for the mobile snapshot (MC-1620 /
// T7). ADDITIVE: it reads roadmap state the same way the desktop board does — the
// roadmap files, the orchestrator's per-lane runtime sidecar, and the backlog
// statuses — and derives the SAME per-lane model (`buildRoadmapBoardModel`), then
// projects only what a phone progress view needs: how far each lane is, the running
// step's title, and whether it is paused. No paths, no run state, nothing steerable.
//
// It reads the persisted sidecar directly (like the automations reader news up its
// store), so it needs no orchestrator ports and touches nothing outside this file.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { listBacklogItems } from '../../backlog-service'
import { createRoadmapOrchestratorStore } from '../../roadmap-orchestrator-store'
import { parseRoadmap, roadmapRefSlug } from '../../../shared/backlog/roadmap'
import type { BacklogItemStatusPayload } from '../../../shared/electron-api'
import {
  buildRoadmapBoardModel,
  type RoadmapBoardItemInfo,
  type RoadmapBoardResolver,
  type RoadmapLaneStateView,
} from '../../../shared/sprintengine/roadmap-surface'
import type { RoadmapLaneRuntime } from '../../../shared/sprintengine/roadmap-orchestrator'
import type { MobileControlRoadmapRider } from '../../../shared/mobile-control/protocol'

// Only roadmaps the orchestrator actually walks get a rider — a completed/archived/
// idea roadmap is not live progress. Mirrors ACTIVE_ROADMAP_STATUSES in
// src/main/roadmap-orchestrator.ts.
const ACTIVE_ROADMAP_STATUSES = new Set<BacklogItemStatusPayload>(['ready', 'in_progress', 'needs_input'])

export async function readMobileRoadmapRiders(workspaceRoot: string): Promise<MobileControlRoadmapRider[]> {
  const listed = await listBacklogItems(workspaceRoot).catch(() => null)
  if (!listed || !listed.ok) return []

  const infoByPath = new Map<string, RoadmapBoardItemInfo>()
  for (const item of listed.items) {
    infoByPath.set(item.relativePath.toLowerCase(), {
      title: item.title,
      status: (item.status ?? 'idea') as BacklogItemStatusPayload,
    })
  }
  // The roadmap file lives in the home project, so this per-workspace pass resolves
  // items in that same project (projectKey null); cross-project entries are surfaced
  // as unknown here, which the read-only progress rider tolerates.
  const resolver: RoadmapBoardResolver = {
    itemInfo: (projectKey, relativePath) => (projectKey === null ? infoByPath.get(relativePath.toLowerCase()) : undefined),
    projectName: (projectKey) => projectKey ?? 'This project',
    resolvableProjects: new Set([null]),
  }

  const store = createRoadmapOrchestratorStore(workspaceRoot)
  const riders: MobileControlRoadmapRider[] = []

  for (const item of listed.items) {
    if (!item.isRoadmap) continue
    if (!ACTIVE_ROADMAP_STATUSES.has((item.status ?? 'idea') as BacklogItemStatusPayload)) continue

    let content: string
    try {
      content = await readFile(join(workspaceRoot, item.relativePath), 'utf8')
    } catch {
      continue // roadmap file unreadable — omit rather than guess.
    }
    const roadmap = parseRoadmap(content)
    if (roadmap.lanes.length === 0) continue

    const runtime = await store.read(item.relativePath)
    const laneRuntime = new Map<string, RoadmapLaneStateView>()
    for (const [lane, value] of runtime) laneRuntime.set(lane, toLaneStateView(value))

    const lanes = buildRoadmapBoardModel(roadmap, resolver, laneRuntime).map((lane) => {
      const runningTitle = lane.units.find((unit) => unit.state === 'running')?.title
      return {
        name: lane.lane,
        done: lane.doneCount,
        total: lane.total,
        ...(runningTitle ? { runningItem: runningTitle } : {}),
        ...(lane.parked ? { parked: true } : {}),
      }
    })

    riders.push({
      roadmapId: roadmapRefSlug(item.relativePath),
      name: roadmap.title ?? item.title ?? roadmapRefSlug(item.relativePath),
      lanes,
    })
  }

  return riders
}

// The persisted lane runtime carries exactly the fields the board's state view
// needs (active ref/statePath, parked, pending approval); project it straight.
function toLaneStateView(runtime: RoadmapLaneRuntime): RoadmapLaneStateView {
  return {
    lane: runtime.lane,
    ...(runtime.activeItemRef ? { activeItemRef: runtime.activeItemRef } : {}),
    ...(runtime.activeTeamSlug ? { activeTeamSlug: runtime.activeTeamSlug } : {}),
    ...(runtime.activeStatePath ? { activeStatePath: runtime.activeStatePath } : {}),
    ...(runtime.parked ? { parked: runtime.parked } : {}),
    ...(runtime.pendingApprovalRef ? { pendingApprovalRef: runtime.pendingApprovalRef } : {}),
  }
}
