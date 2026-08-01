// Sprint Engine task-graph layout, edge styling, and zoom constants.
// These are pure data helpers — no React, no JSX, no DOM. The graph view
// component itself (SprintEngineTaskGraphView) still lives in
// SprintEngineBoardPanel.tsx and imports these helpers; this split keeps
// the layout maths separable and testable independently from the renderer.
//
// What lives here:
//   - Layout types: TaskGraphLayoutNode | …Edge | …Layout | …ZoomAnchor
//   - Zoom level constants and `getNextTaskGraphZoom`
//   - `buildTaskGraphLayout` — the topological-level layered layout
//   - `getTaskGraphFocusTaskId` — picks the task the view should auto-center
//   - `taskGraphEdgePath` + `taskGraphEdgeStyle` + `taskGraphEndEdgeStyle`
//   - `taskGraphStatusTone` — the per-status text-color class
//
// What stays in SprintEngineBoardPanel.tsx:
//   - The component itself (state, refs, JSX, keyboard handlers)
//   - JSX leaf components (TaskGraphLegendDot, zoom icons)
//   - `taskGraphNodeStyle` (uses panel-local `hexToRgba`)

import type {
  SprintEngineTask,
  SprintEngineTaskBoardColumn,
  SprintEngineTaskStatus,
} from '../../types/workspace'
import {
  getSprintEngineTaskBoardColumn,
  getSprintEngineRoleAccent,
} from '../../utils/sprintengine'

export type TaskGraphLayoutNode =
  | {
      id: string
      type: 'task'
      task: SprintEngineTask
      x: number
      y: number
      width: number
      height: number
    }
  | {
      id: string
      type: 'end'
      x: number
      y: number
      width: number
      height: number
    }

export type TaskGraphLayoutEdge = {
  id: string
  fromId: string
  toId: string
  color: string
  opacity: number
  weight: number
  dashed: boolean
}

export type TaskGraphLayout = {
  nodes: TaskGraphLayoutNode[]
  nodesById: Record<string, TaskGraphLayoutNode>
  edges: TaskGraphLayoutEdge[]
  canvasWidth: number
  canvasHeight: number
  terminalTaskIds: string[]
  hasCycle: boolean
  missingDependencyCount: number
}

export type TaskGraphZoomAnchor = {
  graphX: number
  graphY: number
  viewportX: number
  viewportY: number
}

export const taskGraphZoomLevels = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2]
export const defaultTaskGraphZoom = 1
export const minTaskGraphZoom = taskGraphZoomLevels[0]
export const maxTaskGraphZoom = taskGraphZoomLevels[taskGraphZoomLevels.length - 1]

export function getNextTaskGraphZoom(currentZoom: number, direction: 'in' | 'out'): number {
  if (direction === 'in') {
    return taskGraphZoomLevels.find((level) => level > currentZoom + 0.001) ?? taskGraphZoomLevels[taskGraphZoomLevels.length - 1]
  }

  return [...taskGraphZoomLevels].reverse().find((level) => level < currentZoom - 0.001) ?? taskGraphZoomLevels[0]
}

export function buildTaskGraphLayout(tasks: SprintEngineTask[]): TaskGraphLayout {
  const nodeWidth = 272
  const nodeHeight = 154
  const endNodeWidth = 252
  const endNodeHeight = 154
  const levelGap = 420
  const rowGap = 236
  const paddingX = 220
  const paddingY = 132
  const minCanvasWidth = 1180
  const minCanvasHeight = 720

  if (tasks.length === 0) {
    return {
      nodes: [],
      nodesById: {},
      edges: [],
      canvasWidth: minCanvasWidth,
      canvasHeight: minCanvasHeight,
      terminalTaskIds: [],
      hasCycle: false,
      missingDependencyCount: 0,
    }
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const validDepsByTask = new Map<string, string[]>()
  const dependentsByTask = new Map<string, string[]>()
  const indegreeByTask = new Map<string, number>()
  let missingDependencyCount = 0

  tasks.forEach((task) => {
    validDepsByTask.set(task.id, [])
    dependentsByTask.set(task.id, [])
    indegreeByTask.set(task.id, 0)
  })

  tasks.forEach((task) => {
    const uniqueDeps = Array.from(new Set(task.dependsOn))
    uniqueDeps.forEach((depId) => {
      if (depId === task.id || !taskById.has(depId)) {
        missingDependencyCount += 1
        return
      }

      validDepsByTask.get(task.id)?.push(depId)
      dependentsByTask.get(depId)?.push(task.id)
      indegreeByTask.set(task.id, (indegreeByTask.get(task.id) ?? 0) + 1)
    })
  })

  const levelByTask = new Map<string, number>()
  const queue = tasks
    .filter((task) => (indegreeByTask.get(task.id) ?? 0) === 0)
    .map((task) => task.id)
  const visited = new Set<string>()

  queue.forEach((taskId) => levelByTask.set(taskId, 0))

  while (queue.length > 0) {
    const taskId = queue.shift()!
    visited.add(taskId)
    const currentLevel = levelByTask.get(taskId) ?? 0

    dependentsByTask.get(taskId)?.forEach((dependentId) => {
      levelByTask.set(dependentId, Math.max(levelByTask.get(dependentId) ?? 0, currentLevel + 1))
      const nextIndegree = (indegreeByTask.get(dependentId) ?? 0) - 1
      indegreeByTask.set(dependentId, nextIndegree)
      if (nextIndegree === 0) queue.push(dependentId)
    })
  }

  const hasCycle = visited.size < tasks.length
  if (hasCycle) {
    const fallbackStart = Math.max(0, ...Array.from(levelByTask.values())) + 1
    tasks.forEach((task, index) => {
      if (visited.has(task.id)) return
      const dependencyLevels = (validDepsByTask.get(task.id) ?? [])
        .map((depId) => levelByTask.get(depId))
        .filter((level): level is number => typeof level === 'number')
      const nextLevel = dependencyLevels.length > 0
        ? Math.max(...dependencyLevels) + 1
        : fallbackStart + Math.floor(index / 3)
      levelByTask.set(task.id, nextLevel)
    })
  }

  const groups = new Map<number, SprintEngineTask[]>()
  tasks.forEach((task) => {
    const level = levelByTask.get(task.id) ?? 0
    const group = groups.get(level) ?? []
    group.push(task)
    groups.set(level, group)
  })

  const maxTaskLevel = Math.max(0, ...Array.from(groups.keys()))
  const endLevel = maxTaskLevel + 1
  const maxRows = Math.max(1, ...Array.from(groups.values()).map((group) => group.length))
  const canvasHeight = Math.max(minCanvasHeight, paddingY * 2 + nodeHeight + (maxRows - 1) * rowGap)
  const canvasWidth = Math.max(minCanvasWidth, paddingX * 2 + endLevel * levelGap + endNodeWidth)
  const nodes: TaskGraphLayoutNode[] = []

  Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .forEach(([level, group]) => {
      const columnTop = canvasHeight / 2 - ((group.length - 1) * rowGap) / 2
      group.forEach((task, index) => {
        nodes.push({
          id: task.id,
          type: 'task',
          task,
          x: paddingX + level * levelGap,
          y: columnTop + index * rowGap,
          width: nodeWidth,
          height: nodeHeight,
        })
      })
    })

  const endNode: TaskGraphLayoutNode = {
    id: 'end-product',
    type: 'end',
    x: paddingX + endLevel * levelGap,
    y: canvasHeight / 2,
    width: endNodeWidth,
    height: endNodeHeight,
  }
  nodes.push(endNode)

  const terminalTaskIds = tasks
    .filter((task) => (dependentsByTask.get(task.id) ?? []).length === 0)
    .map((task) => task.id)
  const fallbackTerminalTaskIds = terminalTaskIds.length > 0
    ? terminalTaskIds
    : tasks.filter((task) => (levelByTask.get(task.id) ?? 0) === maxTaskLevel).map((task) => task.id)

  const edges: TaskGraphLayoutEdge[] = []
  tasks.forEach((task) => {
    ;(validDepsByTask.get(task.id) ?? []).forEach((depId) => {
      const dependency = taskById.get(depId)
      if (!dependency) return
      edges.push({
        id: `${depId}->${task.id}`,
        fromId: depId,
        toId: task.id,
        ...taskGraphEdgeStyle(dependency, task),
      })
    })
  })

  fallbackTerminalTaskIds.forEach((taskId) => {
    const task = taskById.get(taskId)
    if (!task) return
    edges.push({
      id: `${taskId}->end-product`,
      fromId: taskId,
      toId: 'end-product',
      ...taskGraphEndEdgeStyle(task),
    })
  })

  const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]))

  return {
    nodes,
    nodesById,
    edges,
    canvasWidth,
    canvasHeight,
    terminalTaskIds: fallbackTerminalTaskIds,
    hasCycle,
    missingDependencyCount,
  }
}

export function getTaskGraphFocusTaskId(tasks: SprintEngineTask[]): string | null {
  const newestBy = (candidates: SprintEngineTask[], field: 'startedAt' | 'completedAt') =>
    candidates
      .map((task, index) => ({ task, index }))
      .sort((a, b) => {
        const timeDelta = timestampMs(b.task[field]) - timestampMs(a.task[field])
        return timeDelta !== 0 ? timeDelta : b.index - a.index
      })[0]?.task.id ?? null

  return (
    newestBy(tasks.filter((task) => task.status === 'in_progress'), 'startedAt')
    ?? newestBy(tasks.filter((task) => task.status === 'needs_input'), 'startedAt')
    ?? newestBy(tasks.filter((task) => task.status === 'done'), 'completedAt')
    ?? tasks.find((task) => getSprintEngineTaskBoardColumn(task, tasks) === 'ready')?.id
    ?? tasks[0]?.id
    ?? null
  )
}

function timestampMs(value: string | null): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function taskGraphEdgePath(from: TaskGraphLayoutNode, to: TaskGraphLayoutNode): string {
  const startX = from.x + from.width / 2
  const startY = from.y
  const endX = to.x - to.width / 2
  const endY = to.y
  const horizontalGap = endX - startX

  if (horizontalGap < 120) {
    const curve = Math.max(72, horizontalGap * 0.42)
    return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`
  }

  if (Math.abs(endY - startY) < 2) {
    return `M ${startX} ${startY} H ${endX}`
  }

  const gutterX = startX + horizontalGap / 2
  const direction = endY > startY ? 1 : -1
  const radius = Math.min(22, Math.abs(endY - startY) / 2, Math.abs(gutterX - startX) / 2, Math.abs(endX - gutterX) / 2)

  return [
    `M ${startX} ${startY}`,
    `H ${gutterX - radius}`,
    `Q ${gutterX} ${startY} ${gutterX} ${startY + radius * direction}`,
    `V ${endY - radius * direction}`,
    `Q ${gutterX} ${endY} ${gutterX + radius} ${endY}`,
    `H ${endX}`,
  ].join(' ')
}

// An edge has to be drawn, so a task with no role gives it a chrome tone rather
// than the neutral role accent — the line says "these tasks depend on each
// other", never anything about a role the task does not have (MC-2055).
function taskGraphLineColor(task: SprintEngineTask): string {
  return task.role ? getSprintEngineRoleAccent(task.role) : 'var(--border-strong)'
}

export function taskGraphEdgeStyle(
  dependency: SprintEngineTask,
  dependent: SprintEngineTask,
): Omit<TaskGraphLayoutEdge, 'id' | 'fromId' | 'toId'> {
  const dependencyDone = dependency.status === 'done'
  const active = dependent.status === 'in_progress' || dependent.status === 'needs_input'
  const color = active
    ? taskGraphLineColor(dependent)
    : dependencyDone
      ? 'var(--tone-good)'
      : taskGraphLineColor(dependency)

  return {
    color,
    opacity: active ? 0.68 : dependencyDone ? 0.48 : 0.3,
    weight: active ? 2.2 : 1.6,
    dashed: false,
  }
}

export function taskGraphEndEdgeStyle(
  task: SprintEngineTask,
): Omit<TaskGraphLayoutEdge, 'id' | 'fromId' | 'toId'> {
  return {
    color: task.status === 'done' ? 'var(--tone-good)' : taskGraphLineColor(task),
    opacity: task.status === 'done' ? 0.58 : 0.32,
    weight: task.status === 'done' ? 2 : 1.5,
    dashed: false,
  }
}

export function taskGraphStatusTone(
  taskStatus: SprintEngineTaskStatus,
  boardColumn: SprintEngineTaskBoardColumn,
): string {
  if (boardColumn === 'ready') return 'text-[color:var(--tone-good)]'
  if (boardColumn === 'review') return 'text-[color:var(--tone-warn)]'

  switch (taskStatus) {
    case 'done':
      return 'text-[color:var(--tone-good)]'
    case 'needs_input':
      return 'text-[color:var(--tone-warn)]'
    case 'in_progress':
      return 'text-[color:var(--tone-warn)]'
    default:
      return 'text-[color:var(--text-muted)]'
  }
}
