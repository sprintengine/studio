import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion'
import type { CSSProperties } from 'react'

import {
  baseFont,
  ink,
  model as modelTable,
  monoFont,
  premiumBezier,
  roleAccent,
  roleLabel,
  type ModelId,
  type RoleId,
} from './tokens'
import {
  buildTopoLevels,
  epic,
  lanes,
  laneAtOffset,
  lastMoveOffset,
  reviewGates,
  roster,
  tasks,
  type LaneId,
  type SprintTask,
} from './data'
import { sceneWindow } from './scenes'
import {
  AppShell,
  CaptionBar,
  ModelChip,
  MulticodeMark,
  RoleAvatar,
  easeBezier,
  useSceneEnvelope,
} from './parts'
import './fonts'

// Stage geometry (canvas 1920×1080 minus shell inset 54, top bar 66, sidebar 220).
const STAGE_W = 1592
const STAGE_H = 906

export function SprintEngineOrchestration() {
  return (
    <AbsoluteFill style={rootStyle}>
      <AmbientHalo />
      <AppShell>
        <OrchestratorScene />
        <DecomposeScene />
        <GraphScene />
        <ExecuteScene />
        <GatesScene />
        <CtaScene />
      </AppShell>
    </AbsoluteFill>
  )
}

// Slow, low-amplitude background life — never demands attention (10–20%).
function AmbientHalo() {
  const frame = useCurrentFrame()
  const drift = Math.sin(frame / 90) * 40
  const breathe = 0.5 + 0.5 * Math.sin(frame / 70)
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          top: 120 + drift,
          left: 960,
          width: 1400,
          height: 1400,
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(63,148,104,${0.1 + breathe * 0.05}) 0%, rgba(63,148,104,0) 62%)`,
          filter: 'blur(30px)',
        }}
      />
    </AbsoluteFill>
  )
}

// A scene layer: fades in/out against the persistent shell via its envelope.
function SceneLayer({
  id,
  children,
}: {
  id: Parameters<typeof sceneWindow>[0]
  children: (local: number) => CSSProperties | JSX.Element
}) {
  const win = sceneWindow(id)
  const env = useSceneEnvelope(win.start, win.end)
  const frame = useCurrentFrame()
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: env }}>
      {children(frame - win.start) as JSX.Element}
    </div>
  )
}

// ============================ Scene 1 — Orchestrator ============================

function OrchestratorScene() {
  const win = sceneWindow('orchestrator')
  return (
    <SceneLayer id="orchestrator">
      {(local) => {
        const rise = easeBezier(local, [6, 34], [40, 0])
        const appear = easeBezier(local, [6, 30], [0, 1])
        const centerX = STAGE_W / 2
        const hubY = 300
        // Worker satellites fanned in an arc below the architect hub — one per
        // vendor the user staffs: Opus on frontend + test, Codex on backend +
        // security, GLM on a second backend dev.
        const satellites = [
          { role: 'frontend' as RoleId, model: 'opus-4.8' as ModelId },
          { role: 'developer' as RoleId, model: 'codex-5.5' as ModelId },
          { role: 'developer' as RoleId, model: 'glm-5.2' as ModelId },
          { role: 'security' as RoleId, model: 'codex-5.5' as ModelId },
          { role: 'tester' as RoleId, model: 'opus-4.8' as ModelId },
        ]
        const arcY = 620
        const spread = 1180
        return (
          <>
            {/* connector lines from hub to satellites */}
            <svg style={{ position: 'absolute', inset: 0 }} width={STAGE_W} height={STAGE_H}>
              {satellites.map((s, i) => {
                const x = centerX - spread / 2 + (spread / (satellites.length - 1)) * i
                const draw = easeBezier(local, [30 + i * 5, 60 + i * 5], [0, 1])
                const midY = (hubY + arcY) / 2
                const path = `M ${centerX} ${hubY + 44} C ${centerX} ${midY}, ${x} ${midY}, ${x} ${arcY - 34}`
                return (
                  <path
                    key={i}
                    d={path}
                    fill="none"
                    stroke={roleAccent[s.role]}
                    strokeWidth={1.6}
                    strokeOpacity={0.3}
                    pathLength={1}
                    strokeDasharray={1}
                    strokeDashoffset={1 - draw}
                  />
                )
              })}
            </svg>

            {/* architect hub */}
            <div
              style={{
                position: 'absolute',
                left: centerX,
                top: hubY,
                transform: `translate(-50%, -50%) translateY(${rise}px)`,
                opacity: appear,
              }}
            >
              <HubNode />
            </div>

            {/* satellites */}
            {satellites.map((s, i) => {
              const x = centerX - spread / 2 + (spread / (satellites.length - 1)) * i
              const pop = easeBezier(local, [40 + i * 5, 66 + i * 5], [0, 1])
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: x,
                    top: arcY,
                    transform: `translate(-50%, -50%) scale(${0.9 + pop * 0.1})`,
                    opacity: pop,
                  }}
                >
                  <SatelliteNode role={s.role} model={s.model} />
                </div>
              )
            })}

            <CaptionBar
              kicker="Sprint Engine"
              caption="One architect orchestrates the whole team."
              progress={easeBezier(local, [win.duration - 118, win.duration - 92], [0, 1])}
            />
          </>
        )
      }}
    </SceneLayer>
  )
}

function HubNode() {
  return (
    <div
      style={{
        position: 'relative',
        width: 340,
        padding: 22,
        borderRadius: 18,
        border: `1px solid ${roleAccent.architect}66`,
        background: `linear-gradient(180deg, ${ink.surfaceRaised}, ${ink.surface})`,
        boxShadow: `0 0 90px ${roleAccent.architect}22, 0 30px 80px rgba(0,0,0,0.5)`,
        ...baseFont,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <RoleAvatar role="architect" size={48} />
        <div>
          <div style={{ color: ink.textStrong, fontSize: 22, fontWeight: 700 }}>Architect</div>
          <div style={{ ...monoFont, color: ink.textMuted, fontSize: 13, marginTop: 2 }}>Orchestrator</div>
        </div>
      </div>
      <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <ModelChip modelId="fable-5" />
        <span style={{ ...monoFont, color: ink.accent, fontSize: 12.5 }}>plans · assigns · reviews</span>
      </div>
    </div>
  )
}

function SatelliteNode({ role, model }: { role: RoleId; model: ModelId }) {
  return (
    <div
      style={{
        width: 178,
        padding: 12,
        borderRadius: 12,
        border: `1px solid ${ink.hairline}`,
        background: ink.surface,
        boxShadow: '0 16px 40px rgba(0,0,0,0.4)',
        ...baseFont,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <RoleAvatar role={role} size={30} />
        <div style={{ color: ink.text, fontSize: 12.5, fontWeight: 600, lineHeight: 1.2 }}>{roleLabel[role]}</div>
      </div>
      <div style={{ marginTop: 10 }}>
        <ModelChip modelId={model} />
      </div>
    </div>
  )
}

// ============================ Scene 2 — Decompose ============================

function DecomposeScene() {
  const win = sceneWindow('decompose')
  return (
    <SceneLayer id="decompose">
      {(local) => {
        const epicPop = easeBezier(local, [6, 28], [0, 1])
        const epicY = easeBezier(local, [6, 28], [30, 0])
        // Grid of 9 tasks fanning down from the epic.
        const cols = 3
        return (
          <>
            {/* epic card */}
            <div
              style={{
                position: 'absolute',
                left: STAGE_W / 2,
                top: 96,
                transform: `translate(-50%, 0) translateY(${epicY}px)`,
                opacity: epicPop,
                width: 620,
              }}
            >
              <div style={styles.epicCard}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={styles.epicKey}>{epic.key}</span>
                  <span style={{ color: ink.textStrong, fontSize: 21, fontWeight: 700 }}>{epic.title}</span>
                </div>
                <div style={{ color: ink.textMuted, fontSize: 14, lineHeight: 1.5, marginTop: 10 }}>{epic.brief}</div>
              </div>
            </div>

            {/* connector from epic down to grid */}
            <svg style={{ position: 'absolute', inset: 0 }} width={STAGE_W} height={STAGE_H}>
              <path
                d={`M ${STAGE_W / 2} 210 V 268`}
                stroke={ink.border}
                strokeWidth={1.5}
                fill="none"
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - easeBezier(local, [28, 44], [0, 1])}
              />
            </svg>

            {/* task grid */}
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 300,
                transform: 'translateX(-50%)',
                width: 1160,
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: 16,
              }}
            >
              {tasks.map((task, i) => {
                const start = 40 + i * 8
                const pop = easeBezier(local, [start, start + 24], [0, 1])
                const y = easeBezier(local, [start, start + 24], [22, 0])
                return (
                  <div key={task.id} style={{ opacity: pop, transform: `translateY(${y}px)` }}>
                    <TaskCard task={task} />
                  </div>
                )
              })}
            </div>

            <CaptionBar
              kicker="Architect · Fable 5"
              caption="The brief becomes a dependency-ordered set of tasks."
              progress={easeBezier(local, [win.duration - 150, win.duration - 124], [0, 1])}
            />
          </>
        )
      }}
    </SceneLayer>
  )
}

function TaskCard({ task, compact = false }: { task: SprintTask; compact?: boolean }) {
  const accent = roleAccent[task.role]
  return (
    <div
      style={{
        border: `1px solid ${ink.hairline}`,
        borderLeft: `2px solid ${accent}`,
        borderRadius: 10,
        background: ink.card,
        padding: compact ? 10 : 13,
        ...baseFont,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...monoFont, color: ink.textMuted, fontSize: 11 }}>{task.id}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...monoFont, color: accent, fontSize: 10.5 }}>{roleLabel[task.role]}</span>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: accent }} />
        </span>
      </div>
      <div style={{ color: ink.textStrong, fontSize: compact ? 13 : 14.5, fontWeight: 600, marginTop: 8, lineHeight: 1.25 }}>
        {task.title}
      </div>
      {!compact ? (
        <div style={{ marginTop: 11 }}>
          <ModelChip modelId={task.model} />
        </div>
      ) : null}
    </div>
  )
}

// ============================ Scene 3 — Dependency graph ============================

const GRAPH = {
  nodeW: 200,
  nodeH: 96,
  levelGap: 300,
  rowGap: 172,
  padX: 92,
  padY: 60,
}

type GraphNode = { id: string; task?: SprintTask; level: number; x: number; y: number; isEnd?: boolean }

function buildGraph() {
  const levels = buildTopoLevels(tasks)
  const byLevel = new Map<number, SprintTask[]>()
  tasks.forEach((task) => {
    const lvl = levels.get(task.id) ?? 0
    byLevel.set(lvl, [...(byLevel.get(lvl) ?? []), task])
  })
  const maxLevel = Math.max(...Array.from(levels.values()))
  const maxRows = Math.max(...Array.from(byLevel.values()).map((g) => g.length))
  const canvasW = GRAPH.padX * 2 + (maxLevel + 1) * GRAPH.levelGap + GRAPH.nodeW
  const canvasH = GRAPH.padY * 2 + (maxRows - 1) * GRAPH.rowGap + GRAPH.nodeH

  const nodes: GraphNode[] = []
  Array.from(byLevel.entries())
    .sort(([a], [b]) => a - b)
    .forEach(([lvl, group]) => {
      const colTop = canvasH / 2 - ((group.length - 1) * GRAPH.rowGap) / 2 - GRAPH.nodeH / 2
      group.forEach((task, i) => {
        nodes.push({
          id: task.id,
          task,
          level: lvl,
          x: GRAPH.padX + lvl * GRAPH.levelGap,
          y: colTop + i * GRAPH.rowGap,
        })
      })
    })
  const endNode: GraphNode = {
    id: 'end-product',
    level: maxLevel + 1,
    x: GRAPH.padX + (maxLevel + 1) * GRAPH.levelGap,
    y: canvasH / 2 - GRAPH.nodeH / 2,
    isEnd: true,
  }
  nodes.push(endNode)
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const edges: { id: string; from: GraphNode; to: GraphNode; level: number }[] = []
  tasks.forEach((task) => {
    task.dependsOn.forEach((depId) => {
      const from = byId.get(depId)
      const to = byId.get(task.id)
      if (from && to) edges.push({ id: `${depId}->${task.id}`, from, to, level: to.level })
    })
  })
  // terminal task (no dependents) → end-product
  const hasDependent = new Set<string>()
  tasks.forEach((t) => t.dependsOn.forEach((d) => hasDependent.add(d)))
  tasks
    .filter((t) => !hasDependent.has(t.id))
    .forEach((t) => {
      const from = byId.get(t.id)
      if (from) edges.push({ id: `${t.id}->end`, from, to: endNode, level: endNode.level })
    })

  return { nodes, edges, canvasW, canvasH, maxLevel, levels }
}

function graphEdgePath(from: GraphNode, to: GraphNode): string {
  const sx = from.x + GRAPH.nodeW
  const sy = from.y + GRAPH.nodeH / 2
  const ex = to.x
  const ey = to.y + GRAPH.nodeH / 2
  const gutter = sx + (ex - sx) / 2
  const dir = ey > sy ? 1 : -1
  const r = Math.min(20, Math.abs(ey - sy) / 2, Math.abs(gutter - sx) / 2)
  if (Math.abs(ey - sy) < 2) return `M ${sx} ${sy} H ${ex}`
  return [
    `M ${sx} ${sy}`,
    `H ${gutter - r}`,
    `Q ${gutter} ${sy} ${gutter} ${sy + r * dir}`,
    `V ${ey - r * dir}`,
    `Q ${gutter} ${ey} ${gutter + r} ${ey}`,
    `H ${ex}`,
  ].join(' ')
}

function GraphScene() {
  const win = sceneWindow('graph')
  const graph = buildGraph()
  const scale = Math.min((STAGE_W - 120) / graph.canvasW, (STAGE_H - 200) / graph.canvasH)
  const levelIntroStart = 20
  const levelStep = 22

  return (
    <SceneLayer id="graph">
      {(local) => {
        // Topological sweep line: crosses the canvas as levels light up.
        const sweepX = interpolate(
          local,
          [levelIntroStart, levelIntroStart + (graph.maxLevel + 1) * levelStep + 20],
          [0, graph.canvasW],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(...premiumBezier) },
        )
        return (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'relative', width: graph.canvasW, height: graph.canvasH, transform: `scale(${scale})` }}>
              <svg
                width={graph.canvasW}
                height={graph.canvasH}
                style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
              >
                {/* sweep highlight */}
                <rect x={sweepX - 3} y={-20} width={6} height={graph.canvasH + 40} fill={ink.accent} opacity={0.14} />
                {graph.edges.map((edge) => {
                  const appear = edge.level * levelStep + levelIntroStart
                  const draw = easeBezier(local, [appear, appear + 22], [0, 1])
                  const toTask = edge.to.task
                  const active = edge.from.task && local > appear + 22
                  const color = toTask ? roleAccent[toTask.role] : ink.accent
                  return (
                    <path
                      key={edge.id}
                      d={graphEdgePath(edge.from, edge.to)}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeOpacity={active ? 0.55 : 0.34}
                      pathLength={1}
                      strokeDasharray={1}
                      strokeDashoffset={1 - draw}
                    />
                  )
                })}
              </svg>
              {graph.nodes.map((node) => {
                const appear = node.level * levelStep + levelIntroStart
                const pop = easeBezier(local, [appear, appear + 20], [0, 1])
                const y = easeBezier(local, [appear, appear + 20], [14, 0])
                return (
                  <div
                    key={node.id}
                    style={{
                      position: 'absolute',
                      left: node.x,
                      top: node.y,
                      width: GRAPH.nodeW,
                      height: GRAPH.nodeH,
                      opacity: pop,
                      transform: `translateY(${y}px)`,
                    }}
                  >
                    {node.isEnd ? <EndNode /> : <GraphTaskNode task={node.task!} />}
                  </div>
                )
              })}
              {/* level ruler */}
              {Array.from({ length: graph.maxLevel + 1 }).map((_, lvl) => (
                <div
                  key={lvl}
                  style={{
                    position: 'absolute',
                    left: GRAPH.padX + lvl * GRAPH.levelGap,
                    top: -46,
                    width: GRAPH.nodeW,
                    textAlign: 'center',
                    ...monoFont,
                    color: ink.textSubtle,
                    fontSize: 15,
                    opacity: easeBezier(local, [lvl * levelStep + levelIntroStart, lvl * levelStep + levelIntroStart + 18], [0, 1]),
                  }}
                >
                  {lvl === 0 ? 'Level 0 · runs now' : `Level ${lvl}`}
                </div>
              ))}
            </div>
            <CaptionBar
              kicker="Dependency graph"
              caption="A topological sort runs independent work in parallel, dependents in order."
              progress={easeBezier(local, [win.duration - 150, win.duration - 124], [0, 1])}
            />
          </div>
        )
      }}
    </SceneLayer>
  )
}

function GraphTaskNode({ task }: { task: SprintTask }) {
  const accent = roleAccent[task.role]
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 12,
        border: `1px solid ${ink.hairline}`,
        borderLeft: `3px solid ${accent}`,
        background: ink.card,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        boxShadow: '0 14px 34px rgba(0,0,0,0.35)',
        ...baseFont,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...monoFont, color: ink.textMuted, fontSize: 13 }}>{task.id}</span>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: accent }} />
      </div>
      <div style={{ color: ink.textStrong, fontSize: 16, fontWeight: 600, lineHeight: 1.2 }}>{task.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...monoFont, color: accent, fontSize: 12 }}>{roleLabel[task.role]}</span>
        <span style={{ ...monoFont, color: ink.textSubtle, fontSize: 12 }}>{modelTable[task.model].label}</span>
      </div>
    </div>
  )
}

function EndNode() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 12,
        border: `1px solid ${ink.accent}88`,
        background: ink.accentSoft,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        boxShadow: `0 0 50px ${ink.accent}33`,
        ...baseFont,
      }}
    >
      <MulticodeMark size={34} />
      <span style={{ color: ink.textStrong, fontSize: 16, fontWeight: 700 }}>Shipped product</span>
    </div>
  )
}

// ============================ Scene 4 — Parallel execution ============================

function ExecuteScene() {
  return (
    <SceneLayer id="execute">
      {(local) => {
        const laneTasks = tasks.map((task) => ({
          task,
          lane: laneAtOffset(task.id, local),
          movedAt: lastMoveOffset(task.id, local),
        }))
        const done = laneTasks.filter((t) => t.lane === 'done').length
        const active = laneTasks.filter((t) => t.lane === 'in_progress' || t.lane === 'review' || t.lane === 'testing').length
        return (
          <div style={{ position: 'absolute', inset: 30, display: 'grid', gridTemplateColumns: '288px 1fr', gap: 16 }}>
            <RosterRail local={local} />
            <div style={styles.boardPanel}>
              <div style={styles.boardHeader}>
                <div>
                  <div style={{ ...monoFont, color: ink.gold, fontSize: 12 }}>Sprint Engine</div>
                  <div style={{ color: ink.textStrong, fontSize: 22, fontWeight: 700, marginTop: 2 }}>{epic.title}</div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <Metric label="Active" value={String(active)} />
                  <Metric label="Done" value={`${done}/${tasks.length}`} />
                  <Metric label="Parallel" value="4 agents" />
                </div>
              </div>
              <div style={styles.lanes}>
                {lanes.map((lane) => {
                  const inLane = laneTasks.filter((t) => t.lane === lane.id)
                  return (
                    <div key={lane.id} style={styles.lane}>
                      <div style={styles.laneHeader}>
                        <span>{lane.label}</span>
                        <span style={{ ...monoFont, color: ink.textSubtle }}>{inLane.length}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {inLane.map((entry) => (
                          <KanbanCard key={entry.task.id} task={entry.task} moved={entry.movedAt !== null ? local - entry.movedAt : 999} lane={entry.lane} />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: -6 }}>
              <CaptionBar
                kicker="Roster · your subscriptions"
                caption="Each task runs on the model you choose — Opus 4.8, Codex 5.5, GLM 5.2."
                progress={easeBezier(local, [22, 48], [0, 1])}
              />
            </div>
          </div>
        )
      }}
    </SceneLayer>
  )
}

function RosterRail({ local }: { local: number }) {
  return (
    <div style={styles.rosterRail}>
      <div style={{ color: ink.textStrong, fontWeight: 650, fontSize: 16, marginBottom: 12 }}>Roster · {roster.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {roster.map((member, i) => {
          const pop = easeBezier(local, [8 + i * 3, 26 + i * 3], [0, 1])
          const x = easeBezier(local, [8 + i * 3, 26 + i * 3], [-14, 0])
          const live = member.state === 'running' || member.state === 'gate'
          return (
            <div
              key={`${member.role}-${i}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '30px 1fr auto',
                alignItems: 'center',
                gap: 9,
                padding: '6px 4px',
                opacity: pop,
                transform: `translateX(${x}px)`,
              }}
            >
              <RoleAvatar role={member.role} size={30} />
              <div style={{ minWidth: 0 }}>
                <div style={{ color: ink.text, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {roleLabel[member.role]}
                </div>
                <div style={{ ...monoFont, color: ink.textSubtle, fontSize: 10.5 }}>{modelTable[member.model].label}</div>
              </div>
              <PulseDot live={live} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PulseDot({ live }: { live: boolean }) {
  const frame = useCurrentFrame()
  const pulse = 0.5 + 0.5 * Math.sin(frame / 6)
  if (!live) return <span style={{ width: 8, height: 8, borderRadius: 999, background: ink.textDisabled }} />
  return (
    <span
      style={{
        width: 9,
        height: 9,
        borderRadius: 999,
        background: ink.goodTone,
        boxShadow: `0 0 ${8 + pulse * 10}px ${ink.goodTone}`,
      }}
    />
  )
}

function KanbanCard({ task, moved, lane }: { task: SprintTask; moved: number; lane: LaneId }) {
  const accent = roleAccent[task.role]
  const glow = Math.max(0, 1 - moved / 20)
  const done = lane === 'done'
  return (
    <div
      style={{
        border: `1px solid ${glow > 0 ? `rgba(255,191,47,${0.2 + glow * 0.4})` : ink.hairline}`,
        borderRadius: 8,
        background: ink.card,
        padding: 9,
        boxShadow: glow > 0 ? `0 0 ${20 * glow}px rgba(255,191,47,${0.18 * glow})` : 'none',
        ...baseFont,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...monoFont, color: ink.textMuted, fontSize: 10 }}>{task.id}</span>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: done ? ink.goodTone : accent }} />
      </div>
      <div style={{ color: ink.textStrong, fontSize: 12, fontWeight: 600, marginTop: 6, lineHeight: 1.22 }}>{task.title}</div>
      <div style={{ ...monoFont, color: ink.textSubtle, fontSize: 9.5, marginTop: 6 }}>{modelTable[task.model].label}</div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 92, padding: '8px 11px', border: `1px solid ${ink.hairline}`, borderRadius: 9, background: ink.surfaceRaised }}>
      <span style={{ color: ink.textSubtle, fontSize: 11, display: 'block', ...baseFont }}>{label}</span>
      <span style={{ ...monoFont, color: ink.textStrong, fontSize: 16 }}>{value}</span>
    </div>
  )
}

// ============================ Scene 5 — Review gates ============================

const gateGroupLabel: Record<'backend' | 'frontend' | 'shared', string> = {
  backend: 'Backend gates',
  frontend: 'Frontend gates',
  shared: 'Shared gates',
}

function GatesScene() {
  const win = sceneWindow('gates')
  const gateStart = 30
  const gateStep = 18
  return (
    <SceneLayer id="gates">
      {(local) => {
        const changeX = easeBezier(local, [8, 30], [-40, 0])
        return (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 60px' }}>
            {/* entering change */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 44 }}>
              <div style={{ opacity: easeBezier(local, [8, 26], [0, 1]), transform: `translateX(${changeX}px)` }}>
                <div style={styles.changeCard}>
                  <div style={{ ...monoFont, color: ink.textMuted, fontSize: 12 }}>MTR-05 · change</div>
                  <div style={{ color: ink.textStrong, fontSize: 16, fontWeight: 700, marginTop: 4 }}>Usage dashboard UI</div>
                  <div style={{ ...monoFont, color: ink.accent, fontSize: 12, marginTop: 8 }}>+284 −37 · 6 files</div>
                </div>
              </div>
              <div style={{ ...baseFont, color: ink.textMuted, fontSize: 15, maxWidth: 240 }}>
                clears every gate before it can merge
              </div>
            </div>

            {/* gate pipeline grouped by track */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 14 }}>
              {(['backend', 'frontend', 'shared'] as const).map((group) => {
                const gates = reviewGates.filter((g) => g.group === group)
                return (
                  <div key={group} style={styles.gateGroup}>
                    <div style={{ ...monoFont, color: ink.textSubtle, fontSize: 12, marginBottom: 12, letterSpacing: 0.5 }}>
                      {gateGroupLabel[group]}
                    </div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      {gates.map((gate) => {
                        const globalIndex = reviewGates.indexOf(gate)
                        const at = gateStart + globalIndex * gateStep
                        const pop = easeBezier(local, [at, at + 16], [0, 1])
                        const check = easeBezier(local, [at + 16, at + 30], [0, 1])
                        return (
                          <GateStation key={`${gate.role}-${gate.group}`} role={gate.role} model={gate.model} pop={pop} check={check} />
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>

            <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', gap: 12, opacity: easeBezier(local, [140, 160], [0, 1]) }}>
              <span style={styles.goBadge}>GO</span>
              <span style={{ ...baseFont, color: ink.textMuted, fontSize: 15 }}>
                Production Readiness verdict — safe to release.
              </span>
            </div>

            <CaptionBar
              kicker="Review gates"
              caption="Every change clears named review gates before it ships."
              progress={easeBezier(local, [win.duration - 150, win.duration - 124], [0, 1])}
            />
          </div>
        )
      }}
    </SceneLayer>
  )
}

function GateStation({ role, model, pop, check }: { role: RoleId; model: ModelId; pop: number; check: number }) {
  return (
    <div
      style={{
        width: 176,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${check > 0.5 ? `${ink.goodTone}66` : ink.hairline}`,
        background: ink.card,
        opacity: pop,
        transform: `translateY(${(1 - pop) * 14}px)`,
        boxShadow: check > 0.5 ? `0 0 24px ${ink.goodTone}22` : 'none',
        ...baseFont,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <RoleAvatar role={role} size={30} />
        <CheckMark progress={check} />
      </div>
      <div style={{ color: ink.textStrong, fontSize: 13.5, fontWeight: 600, marginTop: 10, lineHeight: 1.2 }}>{roleLabel[role]}</div>
      <div style={{ ...monoFont, color: ink.textSubtle, fontSize: 11, marginTop: 6 }}>{modelTable[model].label}</div>
    </div>
  )
}

function CheckMark({ progress }: { progress: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22">
      <circle cx="11" cy="11" r="10" fill="none" stroke={progress > 0 ? ink.goodTone : ink.hairline} strokeWidth="1.5" strokeOpacity={progress > 0 ? 0.5 : 1} />
      <path
        d="M6 11.5 L9.5 15 L16 7.5"
        fill="none"
        stroke={ink.goodTone}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - progress}
      />
    </svg>
  )
}

// ============================ Scene 6 — CTA ============================

function CtaScene() {
  return (
    <SceneLayer id="cta">
      {(local) => {
        const rise = easeBezier(local, [8, 34], [30, 0])
        const appear = easeBezier(local, [8, 30], [0, 1])
        const chips: ModelId[] = ['opus-4.8', 'codex-5.5', 'glm-5.2', 'fable-5']
        return (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30 }}>
            <div style={{ opacity: appear, transform: `translateY(${rise}px)`, display: 'flex', alignItems: 'center', gap: 16 }}>
              <MulticodeMark size={64} />
              <span style={{ ...baseFont, color: ink.textStrong, fontSize: 56, fontWeight: 700 }}>Sprint Engine</span>
            </div>

            <div style={{ display: 'flex', gap: 22, opacity: easeBezier(local, [24, 48], [0, 1]) }}>
              <StatTile label="Tasks" value={`${tasks.length}/${tasks.length}`} sub="done" />
              <StatTile label="Review gates" value="GO" sub="all cleared" accent={ink.goodTone} />
              <StatTile label="Vendors" value="3" sub="one team" />
            </div>

            <div style={{ display: 'flex', gap: 10, opacity: easeBezier(local, [36, 60], [0, 1]) }}>
              {chips.map((m) => (
                <ModelChip key={m} modelId={m} />
              ))}
            </div>

            <div
              style={{
                ...baseFont,
                color: ink.textStrong,
                fontSize: 34,
                fontWeight: 600,
                textAlign: 'center',
                maxWidth: 980,
                lineHeight: 1.3,
                marginTop: 10,
                opacity: easeBezier(local, [50, 78], [0, 1]),
              }}
            >
              Sprint Engine orchestrates the terminals.{' '}
              <span style={{ color: ink.accent }}>You bring the models.</span>
            </div>
            <div style={{ ...monoFont, color: ink.textMuted, fontSize: 16, opacity: easeBezier(local, [64, 88], [0, 1]) }}>
              your subscriptions · your keys · your team
            </div>
          </div>
        )
      }}
    </SceneLayer>
  )
}

function StatTile({ label, value, sub, accent = ink.textStrong }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div style={{ minWidth: 190, padding: '18px 22px', border: `1px solid ${ink.hairline}`, borderRadius: 14, background: ink.surface, textAlign: 'center' }}>
      <div style={{ ...monoFont, color: ink.textSubtle, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ ...baseFont, color: accent, fontSize: 40, fontWeight: 700, marginTop: 6 }}>{value}</div>
      <div style={{ ...baseFont, color: ink.textMuted, fontSize: 13, marginTop: 2 }}>{sub}</div>
    </div>
  )
}

// ============================ shared styles ============================

const rootStyle: CSSProperties = {
  ...baseFont,
  background: ink.base,
  color: ink.text,
}

const styles: Record<string, CSSProperties> = {
  epicCard: {
    borderRadius: 16,
    border: `1px solid ${ink.gold}44`,
    background: `linear-gradient(180deg, ${ink.surfaceRaised}, ${ink.surface})`,
    padding: 22,
    boxShadow: `0 0 60px ${ink.gold}14, 0 24px 60px rgba(0,0,0,0.45)`,
  },
  epicKey: {
    ...monoFont,
    color: ink.gold,
    fontSize: 13,
    padding: '3px 8px',
    borderRadius: 6,
    border: `1px solid ${ink.gold}44`,
    background: ink.goldSoft,
  },
  boardPanel: {
    border: `1px solid ${ink.hairline}`,
    borderRadius: 14,
    background: ink.surface,
    padding: 18,
    minWidth: 0,
  },
  boardHeader: { height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  lanes: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, height: 'calc(100% - 60px)' },
  lane: { border: `1px solid ${ink.hairlineSoft}`, borderRadius: 10, background: ink.surfaceRaised, padding: 9, minWidth: 0 },
  laneHeader: { display: 'flex', justifyContent: 'space-between', color: ink.text, fontWeight: 650, fontSize: 12.5, marginBottom: 10, ...baseFont },
  rosterRail: { border: `1px solid ${ink.hairline}`, borderRadius: 14, background: ink.surfaceRaised, padding: 14, minWidth: 0 },
  changeCard: {
    width: 260,
    padding: 16,
    borderRadius: 12,
    border: `1px solid ${roleAccent.frontend}55`,
    borderLeft: `3px solid ${roleAccent.frontend}`,
    background: ink.card,
    boxShadow: '0 18px 44px rgba(0,0,0,0.4)',
  },
  gateGroup: {
    flex: 1,
    padding: 16,
    borderRadius: 14,
    border: `1px solid ${ink.hairlineSoft}`,
    background: 'rgba(255,255,255,0.015)',
  },
  goBadge: {
    ...monoFont,
    fontSize: 15,
    fontWeight: 700,
    color: ink.goodTone,
    padding: '4px 12px',
    borderRadius: 8,
    border: `1px solid ${ink.goodTone}66`,
    background: `${ink.goodTone}1a`,
  },
}
