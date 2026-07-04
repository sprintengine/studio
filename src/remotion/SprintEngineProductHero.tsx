import type { CSSProperties, ReactNode } from 'react'
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'

const palette = {
  app: '#08090b',
  panel: '#0d0e11',
  raised: '#111216',
  hover: '#17181d',
  ink: '#ececee',
  text: '#c7c8cf',
  muted: '#7b7d86',
  faint: '#555861',
  border: 'rgba(255,255,255,0.08)',
  borderSubtle: 'rgba(255,255,255,0.055)',
  green: '#3f9468',
  greenBright: '#69bc8c',
  greenSoft: 'rgba(63,148,104,0.13)',
  gold: '#ffbf2f',
  good: '#48a878',
  warn: '#d4a757',
  error: '#e26d75',
}

const roleColors: Record<string, string> = {
  architect: '#d4a757',
  frontend: '#39d7ff',
  backend: '#c7ccd4',
  ux: '#e879a7',
  spec: '#a78bfa',
  review: '#47c87c',
  test: '#ff7272',
  security: '#f59e0b',
  release: '#7f9cff',
}

type RosterMember = {
  initials: string
  role: string
  responsibility: string
  cli: string
  model: string
  color: string
}

const architect: RosterMember = {
  initials: 'AR',
  role: 'Architect',
  responsibility: 'Plans, delegates, and reviews every gate',
  cli: 'Claude Code',
  model: 'Claude Opus',
  color: roleColors.architect,
}

const roster: RosterMember[] = [
  {
    initials: 'FE',
    role: 'Frontend developer',
    responsibility: 'Interface implementation',
    cli: 'Codex',
    model: 'Codex',
    color: roleColors.frontend,
  },
  {
    initials: 'BE',
    role: 'Backend developer',
    responsibility: 'API and data model',
    cli: 'GLM',
    model: 'GLM',
    color: roleColors.backend,
  },
  {
    initials: 'UX',
    role: 'UX reviewer',
    responsibility: 'Interaction and accessibility',
    cli: 'Claude Code',
    model: 'Claude Sonnet',
    color: roleColors.ux,
  },
  {
    initials: 'SP',
    role: 'Spec reviewer',
    responsibility: 'Acceptance criteria',
    cli: 'Claude Code',
    model: 'Claude Opus',
    color: roleColors.spec,
  },
  {
    initials: 'CR',
    role: 'Code reviewer',
    responsibility: 'Correctness and maintainability',
    cli: 'Codex',
    model: 'Codex',
    color: roleColors.review,
  },
  {
    initials: 'QA',
    role: 'Tester',
    responsibility: 'Integration and regression',
    cli: 'GLM',
    model: 'GLM',
    color: roleColors.test,
  },
  {
    initials: 'SC',
    role: 'Security specialist',
    responsibility: 'Threat model and audit',
    cli: 'Custom CLI',
    model: 'Security model',
    color: roleColors.security,
  },
  {
    initials: 'PR',
    role: 'Production reviewer',
    responsibility: 'Release readiness',
    cli: 'Claude Code',
    model: 'Claude Sonnet',
    color: roleColors.release,
  },
]

type GraphNode = {
  id: string
  title: string
  role: string
  model: string
  wave: number
  x: number
  y: number
  color: string
}

const graphNodes: GraphNode[] = [
  { id: 'plan', title: 'Approve sprint plan', role: 'Architect', model: 'Claude Opus', wave: 0, x: 124, y: 366, color: roleColors.architect },
  { id: 'api', title: 'Define API contract', role: 'Backend', model: 'GLM', wave: 1, x: 370, y: 222, color: roleColors.backend },
  { id: 'ux', title: 'Define UX system', role: 'Frontend', model: 'Codex', wave: 1, x: 370, y: 510, color: roleColors.frontend },
  { id: 'backend', title: 'Build workspace API', role: 'Backend', model: 'GLM', wave: 2, x: 626, y: 148, color: roleColors.backend },
  { id: 'sync', title: 'Implement sync engine', role: 'Backend', model: 'Codex', wave: 2, x: 626, y: 366, color: roleColors.review },
  { id: 'frontend', title: 'Build workspace UI', role: 'Frontend', model: 'Codex', wave: 2, x: 626, y: 584, color: roleColors.frontend },
  { id: 'code', title: 'Code review', role: 'Reviewer', model: 'Codex', wave: 3, x: 884, y: 148, color: roleColors.review },
  { id: 'security', title: 'Security audit', role: 'Security', model: 'Specialist', wave: 3, x: 884, y: 366, color: roleColors.security },
  { id: 'ux-review', title: 'UX + spec review', role: 'Reviewers', model: 'Claude', wave: 3, x: 884, y: 584, color: roleColors.ux },
  { id: 'tests', title: 'Integration tests', role: 'Tester', model: 'GLM', wave: 4, x: 1140, y: 366, color: roleColors.test },
  { id: 'release', title: 'Production ready', role: 'Release gate', model: 'Claude', wave: 5, x: 1388, y: 366, color: roleColors.release },
]

const graphEdges: Array<[string, string]> = [
  ['plan', 'api'],
  ['plan', 'ux'],
  ['api', 'backend'],
  ['api', 'sync'],
  ['ux', 'sync'],
  ['ux', 'frontend'],
  ['backend', 'code'],
  ['backend', 'security'],
  ['sync', 'security'],
  ['frontend', 'ux-review'],
  ['code', 'tests'],
  ['security', 'tests'],
  ['ux-review', 'tests'],
  ['tests', 'release'],
]

type BoardLane = 'ready' | 'in_progress' | 'review' | 'testing' | 'done'

type BoardTask = {
  id: string
  title: string
  role: string
  model: string
  color: string
  steps: Array<[number, BoardLane]>
}

const boardTasks: BoardTask[] = [
  { id: 'SE-12', title: 'Workspace API', role: 'Backend', model: 'GLM', color: roleColors.backend, steps: [[0, 'in_progress'], [38, 'review'], [76, 'done']] },
  { id: 'SE-18', title: 'Realtime sync', role: 'Backend', model: 'Codex', color: roleColors.review, steps: [[0, 'in_progress'], [47, 'review'], [85, 'done']] },
  { id: 'SE-21', title: 'Workspace interface', role: 'Frontend', model: 'Codex', color: roleColors.frontend, steps: [[0, 'in_progress'], [53, 'review'], [92, 'done']] },
  { id: 'SE-27', title: 'UX acceptance', role: 'UX reviewer', model: 'Claude', color: roleColors.ux, steps: [[0, 'ready'], [53, 'review'], [100, 'done']] },
  { id: 'SE-31', title: 'Spec verification', role: 'Spec reviewer', model: 'Claude', color: roleColors.spec, steps: [[0, 'ready'], [59, 'review'], [107, 'done']] },
  { id: 'SE-35', title: 'Security audit', role: 'Security', model: 'Specialist', color: roleColors.security, steps: [[0, 'ready'], [71, 'testing'], [118, 'done']] },
  { id: 'SE-38', title: 'Integration suite', role: 'Tester', model: 'GLM', color: roleColors.test, steps: [[0, 'ready'], [97, 'testing'], [132, 'done']] },
  { id: 'SE-42', title: 'Production readiness', role: 'Release gate', model: 'Claude', color: roleColors.release, steps: [[0, 'ready'], [128, 'testing'], [150, 'done']] },
]

const boardLanes: Array<{ id: BoardLane; label: string }> = [
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'testing', label: 'Testing' },
  { id: 'done', label: 'Done' },
]

export function SprintEngineProductHero() {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  return (
    <AbsoluteFill style={styles.root}>
      <div style={styles.grid} />
      <ProductWindow frame={frame}>
        <RosterScene frame={frame} fps={fps} />
        <ArchitectScene frame={frame} />
        <GraphScene frame={frame} />
        <BoardScene frame={frame} />
        <OutcomeScene frame={frame} fps={fps} />
      </ProductWindow>
    </AbsoluteFill>
  )
}

function ProductWindow({ frame, children }: { frame: number; children: ReactNode }) {
  const activeView = frame < 212 ? 'Roster' : frame < 660 ? 'Task graph' : frame < 830 ? 'Board' : 'Run summary'

  return (
    <div style={styles.window}>
      <header style={styles.topBar}>
        <BrandLockup />
        <div style={styles.productName}>
          <span style={styles.productDot} />
          Sprint Engine
        </div>
        <div style={styles.topSpacer} />
        <div style={styles.localLabel}>
          <TerminalGlyph />
          Local orchestration
        </div>
      </header>
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeading}>Cairn sprint</div>
        {['Roster', 'Task graph', 'Board', 'Run summary'].map((view) => (
          <div key={view} style={activeView === view ? styles.navActive : styles.navItem}>
            <NavGlyph type={view} active={activeView === view} />
            <span>{view}</span>
          </div>
        ))}
        <div style={styles.sidebarSection}>Agents</div>
        <div style={styles.sidebarAgent}>
          <span style={{ ...styles.sidebarAvatar, color: architect.color }}>AR</span>
          <div>
            <div style={styles.sidebarAgentName}>Architect</div>
            <div style={styles.sidebarAgentMeta}>Claude Opus</div>
          </div>
          <span style={styles.liveDot} />
        </div>
        <div style={styles.sidebarMiniRows}>
          {roster.slice(0, 5).map((member) => (
            <div key={member.role} style={styles.sidebarMiniRow}>
              <span style={{ ...styles.miniRoleBar, background: member.color }} />
              <span>{member.role.replace(' developer', '').replace(' reviewer', '')}</span>
            </div>
          ))}
        </div>
        <div style={styles.sidebarBottom}>
          <div style={styles.subscriptionStack}>
            <ProviderMonogram label="C" color="#d4a757" />
            <ProviderMonogram label="O" color="#c7ccd4" />
            <ProviderMonogram label="G" color="#7f9cff" />
          </div>
          <div>
            <div style={styles.sidebarAgentName}>Your subscriptions</div>
            <div style={styles.sidebarAgentMeta}>Claude · Codex · GLM</div>
          </div>
        </div>
      </aside>
      <main style={styles.stage}>{children}</main>
    </div>
  )
}

function RosterScene({ frame, fps }: { frame: number; fps: number }) {
  const opacity = visibleInRange(frame, 0, 212)
  const intro = spring({ frame: frame - 4, fps, config: { damping: 20, stiffness: 115 } })
  const runButton = interpolate(frame, [182, 206, 214], [0, 1, 0.94], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  return (
    <section style={{ ...styles.scene, opacity }}>
      <SceneHeading
        eyebrow="Sprint roster"
        title="Put your strongest model in charge."
        subtitle="Choose the terminal agent and model for every specialist role."
        progress={intro}
      />
      <div style={styles.rosterGrid}>
        <div style={{ ...styles.architectCard, opacity: enter(frame, 28, 20), transform: `translateY(${(1 - enter(frame, 28, 20)) * 18}px)` }}>
          <div style={styles.cardTopLine}>
            <span style={styles.primaryRoleLabel}>Lead agent</span>
            <span style={styles.premiumLabel}>Highest capability</span>
          </div>
          <div style={styles.architectIdentity}>
            <RoleAvatar member={architect} size={58} />
            <div>
              <div style={styles.architectRole}>{architect.role}</div>
              <div style={styles.architectSummary}>{architect.responsibility}</div>
            </div>
          </div>
          <ModelSelector member={architect} selected frame={frame} start={56} />
          <div style={styles.architectResponsibilities}>
            {['Breaks the goal into tasks', 'Orders dependencies', 'Reviews every quality gate'].map((label, index) => (
              <div key={label} style={{ ...styles.checkRow, opacity: enter(frame, 82 + index * 12, 16) }}>
                <CheckGlyph />
                {label}
              </div>
            ))}
          </div>
        </div>
        <div style={styles.specialistPanel}>
          <div style={styles.specialistHeader}>
            <div>
              <div style={styles.panelTitle}>Specialist team</div>
              <div style={styles.panelSubtitle}>Mix models and vendors role by role</div>
            </div>
            <div style={styles.agentCount}>8 agents</div>
          </div>
          <div style={styles.specialistGrid}>
            {roster.map((member, index) => (
              <RosterRow key={member.role} member={member} frame={frame} index={index} />
            ))}
          </div>
        </div>
      </div>
      <div style={styles.rosterFooter}>
        <span style={styles.footerNote}>Each agent runs in its own managed terminal.</span>
        <button style={{ ...styles.primaryButton, opacity: runButton, transform: `scale(${0.98 + runButton * 0.02})` }}>
          Run sprint
          <ArrowRight />
        </button>
      </div>
    </section>
  )
}

function RosterRow({ member, frame, index }: { member: RosterMember; frame: number; index: number }) {
  const progress = enter(frame, 42 + index * 9, 18)
  const selectionPulse = interpolate(frame, [74 + index * 8, 82 + index * 8, 98 + index * 8], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  return (
    <div
      style={{
        ...styles.rosterRow,
        opacity: progress,
        transform: `translateY(${(1 - progress) * 12}px)`,
        borderColor: selectionPulse > 0 ? `rgba(63,148,104,${0.18 + selectionPulse * 0.36})` : palette.borderSubtle,
      }}
    >
      <RoleAvatar member={member} size={34} />
      <div style={styles.rosterRoleBlock}>
        <div style={styles.rosterRole}>{member.role}</div>
        <div style={styles.rosterResponsibility}>{member.responsibility}</div>
      </div>
      <div style={styles.compactModel}>
        <span style={styles.cliName}>{member.cli}</span>
        <span style={styles.modelName}>{member.model}</span>
        <ChevronDown />
      </div>
    </div>
  )
}

function ArchitectScene({ frame }: { frame: number }) {
  const opacity = visibleInRange(frame, 212, 390)
  const local = frame - 212
  const planProgress = interpolate(local, [32, 146], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const taskLines = [
    ['01', 'Foundation', 'API contract + UX system'],
    ['02', 'Parallel build', 'Backend, sync, and frontend'],
    ['03', 'Specialist review', 'UX, spec, code, and security'],
    ['04', 'Release gates', 'Tests + production readiness'],
  ]

  return (
    <section style={{ ...styles.scene, opacity }}>
      <div style={styles.sceneTopLine}>
        <div>
          <div style={styles.eyebrow}>Architect handoff</div>
          <div style={styles.compactTitle}>One goal becomes an executable sprint.</div>
        </div>
        <ArchitectStatus local={local} />
      </div>
      <div style={styles.planFlow}>
        <div style={{ ...styles.goalCard, opacity: enter(local, 10, 18) }}>
          <div style={styles.goalLabel}>Product goal</div>
          <div style={styles.goalTitle}>Ship collaborative team workspaces</div>
          <div style={styles.goalBody}>Realtime edits, role-based access, responsive UI, and a production-safe rollout.</div>
          <div style={styles.goalMeta}>Brief · acceptance criteria · repository context</div>
        </div>
        <FlowConnector progress={enter(local, 34, 28)} />
        <div style={{ ...styles.architectCore, opacity: enter(local, 24, 20), transform: `scale(${0.94 + enter(local, 24, 20) * 0.06})` }}>
          <RoleAvatar member={architect} size={68} />
          <div style={styles.coreRole}>Architect</div>
          <div style={styles.coreModel}>Claude Opus</div>
          <div style={styles.coreActivity}>
            <Spinner frame={local} />
            {local < 132 ? 'Building the plan' : 'Plan approved'}
          </div>
        </div>
        <FlowConnector progress={enter(local, 54, 28)} />
        <div style={styles.planDocument}>
          <div style={styles.documentHeader}>
            <div>
              <div style={styles.documentTitle}>Sprint plan</div>
              <div style={styles.documentMeta}>plan.md · dependency-aware</div>
            </div>
            <span style={styles.approvedLabel}>{local > 138 ? 'Approved' : 'Drafting'}</span>
          </div>
          <div style={styles.planRows}>
            {taskLines.map(([number, title, detail], index) => {
              const visible = interpolate(planProgress, [index * 0.19, index * 0.19 + 0.22], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
              return (
                <div key={number} style={{ ...styles.planRow, opacity: visible, transform: `translateX(${(1 - visible) * 16}px)` }}>
                  <span style={styles.planNumber}>{number}</span>
                  <div>
                    <div style={styles.planRowTitle}>{title}</div>
                    <div style={styles.planRowDetail}>{detail}</div>
                  </div>
                  <span style={styles.planTaskCount}>{index === 2 ? '4 gates' : index === 1 ? '3 tasks' : '2 tasks'}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div style={{ ...styles.planFooter, opacity: enter(local, 130, 22) }}>
        <CheckGlyph />
        The architect keeps the product intent while specialists get focused, bounded tasks.
      </div>
    </section>
  )
}

function ArchitectStatus({ local }: { local: number }) {
  return (
    <div style={styles.architectStatus}>
      <span style={styles.liveDot} />
      <span>Claude Code terminal</span>
      <span style={styles.statusDivider} />
      <span>{local < 132 ? 'Planning' : 'Reviewing graph'}</span>
    </div>
  )
}

function GraphScene({ frame }: { frame: number }) {
  const opacity = visibleInRange(frame, 390, 660)
  const local = frame - 390
  const wave = graphWave(local)
  const readyCount = graphNodes.filter((node) => node.wave === wave).length

  return (
    <section style={{ ...styles.scene, opacity }}>
      <div style={styles.graphHeader}>
        <div>
          <div style={styles.eyebrow}>Task graph</div>
          <div style={styles.compactTitle}>Dependencies set the order. Ready work runs in parallel.</div>
        </div>
        <div style={styles.graphMetrics}>
          <Metric label="Execution wave" value={`${Math.min(wave + 1, 6)} / 6`} />
          <Metric label="Ready now" value={wave < 6 ? String(readyCount) : '0'} accent />
          <Metric label="Agents active" value={wave === 2 || wave === 3 ? '3' : wave < 6 ? String(Math.max(1, readyCount)) : '0'} />
        </div>
      </div>
      <div style={styles.graphSurface}>
        <div style={styles.waveLabels}>
          {['Plan', 'Foundation', 'Build', 'Review', 'Test', 'Release'].map((label, index) => (
            <div key={label} style={{ ...styles.waveLabel, left: graphNodes.find((node) => node.wave === index)?.x ?? 0 }}>
              <span style={index === wave ? styles.waveLabelActive : undefined}>Wave {index + 1}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <svg style={styles.graphEdges} viewBox="0 0 1510 720" preserveAspectRatio="none" aria-hidden="true">
          {graphEdges.map(([fromId, toId], index) => {
            const from = graphNodes.find((node) => node.id === fromId)!
            const to = graphNodes.find((node) => node.id === toId)!
            const fromState = graphNodeState(from.wave, local)
            const edgeEnter = enter(local, 18 + index * 2, 24)
            const path = edgePath(from, to)
            return (
              <path
                key={`${fromId}-${toId}`}
                d={path}
                fill="none"
                stroke={fromState === 'done' ? palette.good : 'rgba(255,255,255,0.13)'}
                strokeWidth={fromState === 'done' ? 2 : 1.4}
                strokeDasharray="8 7"
                strokeDashoffset={(1 - edgeEnter) * 80}
                opacity={0.3 + edgeEnter * 0.7}
              />
            )
          })}
        </svg>
        {graphNodes.map((node) => (
          <TaskGraphNode key={node.id} node={node} local={local} />
        ))}
      </div>
      <div style={styles.graphLegend}>
        <LegendItem kind="ready" label="Ready when every dependency is done" />
        <LegendItem kind="running" label="Same-wave tasks run concurrently" />
        <LegendItem kind="done" label="Completed work unlocks the next wave" />
      </div>
    </section>
  )
}

function TaskGraphNode({ node, local }: { node: GraphNode; local: number }) {
  const state = graphNodeState(node.wave, local)
  const materialize = enter(local, 10 + node.wave * 10, 22)
  const activePulse = state === 'running' ? 0.5 + Math.sin(local / 7) * 0.5 : 0

  return (
    <div
      style={{
        ...styles.graphNode,
        left: node.x,
        top: node.y,
        opacity: materialize,
        transform: `translate(-50%, -50%) scale(${0.94 + materialize * 0.06})`,
        borderColor: state === 'running' ? `rgba(63,148,104,${0.48 + activePulse * 0.22})` : state === 'done' ? 'rgba(72,168,120,0.26)' : palette.border,
        background: state === 'running' ? palette.greenSoft : palette.raised,
      }}
    >
      <div style={styles.nodeTop}>
        <span style={{ ...styles.nodeRoleDot, background: node.color }} />
        <span style={styles.nodeRole}>{node.role}</span>
        <NodeState state={state} frame={local} />
      </div>
      <div style={styles.nodeTitle}>{node.title}</div>
      <div style={styles.nodeModel}>{node.model}</div>
    </div>
  )
}

function BoardScene({ frame }: { frame: number }) {
  const opacity = visibleInRange(frame, 660, 830)
  const local = frame - 660
  const taskStates = boardTasks.map((task) => ({ task, lane: laneAt(task, local), movedAt: boardMovedAt(task, local) }))
  const doneCount = taskStates.filter(({ lane }) => lane === 'done').length
  const activeCount = taskStates.filter(({ lane }) => lane !== 'ready' && lane !== 'done').length

  return (
    <section style={{ ...styles.scene, opacity }}>
      <div style={styles.boardTop}>
        <div>
          <div style={styles.eyebrow}>Sprint board</div>
          <div style={styles.compactTitle}>Work flows through specialist review gates.</div>
        </div>
        <div style={styles.graphMetrics}>
          <Metric label="Active" value={String(activeCount)} accent={activeCount > 0} />
          <Metric label="Done" value={`${doneCount} / ${boardTasks.length}`} />
          <Metric label="Quality gates" value={`${Math.min(5, Math.floor(Math.max(0, local - 48) / 21))} / 5`} />
        </div>
      </div>
      <div style={styles.boardBody}>
        <div style={styles.liveRoster}>
          <div style={styles.liveRosterTitle}>Live roster</div>
          <LiveAgent name="Architect" model="Claude Opus" state={local < 150 ? 'Reviewing gates' : 'Final review'} color={roleColors.architect} active />
          <div style={styles.rosterRule} />
          <LiveAgent name="Frontend" model="Codex" state={local < 92 ? 'Implementing' : 'Complete'} color={roleColors.frontend} active={local < 92} />
          <LiveAgent name="Backend" model="GLM" state={local < 85 ? 'Implementing' : 'Complete'} color={roleColors.backend} active={local < 85} />
          <LiveAgent name="UX + spec" model="Claude" state={local < 107 ? 'Reviewing' : 'Approved'} color={roleColors.ux} active={local > 48 && local < 107} />
          <LiveAgent name="Code review" model="Codex" state={local < 102 ? 'Reviewing' : 'Approved'} color={roleColors.review} active={local > 54 && local < 102} />
          <LiveAgent name="Security" model="Specialist" state={local < 118 ? 'Auditing' : 'Clear'} color={roleColors.security} active={local > 67 && local < 118} />
          <LiveAgent name="Tester" model="GLM" state={local < 132 ? 'Testing' : 'Passing'} color={roleColors.test} active={local > 92 && local < 132} />
          <LiveAgent name="Production" model="Claude" state={local < 150 ? 'Queued' : 'Ready'} color={roleColors.release} active={local > 126 && local < 150} />
        </div>
        <div style={styles.kanban}>
          {boardLanes.map((lane) => {
            const tasksInLane = taskStates.filter((entry) => entry.lane === lane.id)
            return (
              <div key={lane.id} style={styles.boardLane}>
                <div style={styles.boardLaneHeader}>
                  <span>{lane.label}</span>
                  <span style={styles.laneCount}>{tasksInLane.length}</span>
                </div>
                <div style={styles.laneCards}>
                  {tasksInLane.map((entry) => (
                    <BoardTaskCard key={entry.task.id} entry={entry} local={local} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function BoardTaskCard({ entry, local }: { entry: { task: BoardTask; lane: BoardLane; movedAt: number }; local: number }) {
  const justMoved = Math.max(0, 1 - (local - entry.movedAt) / 22)
  return (
    <div
      style={{
        ...styles.boardCard,
        borderColor: justMoved > 0 ? `rgba(255,191,47,${0.16 + justMoved * 0.34})` : palette.borderSubtle,
        background: justMoved > 0 ? `rgba(255,191,47,${justMoved * 0.035})` : palette.raised,
      }}
    >
      <div style={styles.boardCardTop}>
        <span style={styles.taskId}>{entry.task.id}</span>
        <span style={{ ...styles.cardRoleMark, color: entry.task.color }}>◆</span>
      </div>
      <div style={styles.boardCardTitle}>{entry.task.title}</div>
      <div style={styles.boardCardMeta}>
        <span>{entry.task.role}</span>
        <span>{entry.task.model}</span>
      </div>
    </div>
  )
}

function OutcomeScene({ frame, fps }: { frame: number; fps: number }) {
  const opacity = visibleInRange(frame, 830, 960)
  const local = frame - 830
  const checkProgress = spring({ frame: local - 26, fps, config: { damping: 18, stiffness: 110 } })
  const checks = ['UX approved', 'Spec verified', 'Code reviewed', 'Security clear', 'Tests passing', 'Production ready']

  return (
    <section style={{ ...styles.scene, opacity }}>
      <div style={styles.outcomeLayout}>
        <div style={styles.outcomeCopy}>
          <div style={styles.eyebrow}>Sprint complete</div>
          <h1 style={styles.outcomeTitle}>One architect.<br />A whole engineering team.</h1>
          <p style={styles.outcomeBody}>
            Sprint Engine orchestrates your terminal agents, executes dependency-ready work in parallel, and routes every result through the right reviewers.
          </p>
          <div style={styles.outcomeChecks}>
            {checks.map((label, index) => (
              <div key={label} style={{ ...styles.outcomeCheck, opacity: enter(local, 30 + index * 9, 16), transform: `translateY(${(1 - enter(local, 30 + index * 9, 16)) * 8}px)` }}>
                <span style={styles.outcomeCheckIcon}>✓</span>
                {label}
              </div>
            ))}
          </div>
          <div style={{ ...styles.finalLine, opacity: enter(local, 92, 18) }}>
            Your subscriptions. Your models. One coordinated sprint.
          </div>
        </div>
        <div style={{ ...styles.summaryPanel, transform: `translateY(${(1 - checkProgress) * 24}px)`, opacity: checkProgress }}>
          <div style={styles.summaryHeader}>
            <div>
              <div style={styles.summaryTitle}>Cairn sprint</div>
              <div style={styles.summaryMeta}>Final review by Architect · Claude Opus</div>
            </div>
            <div style={styles.completeMark}>✓</div>
          </div>
          <div style={styles.summaryStats}>
            <SummaryStat value="8" label="Tasks shipped" />
            <SummaryStat value="5/5" label="Gates passed" />
            <SummaryStat value="3" label="Agent CLIs" />
          </div>
          <div style={styles.terminalStack}>
            <TerminalRow cli="claude" text="final review approved" color={roleColors.architect} delay={44} local={local} />
            <TerminalRow cli="codex" text="frontend + code review complete" color={roleColors.frontend} delay={54} local={local} />
            <TerminalRow cli="glm" text="backend + test suite complete" color={roleColors.release} delay={64} local={local} />
            <TerminalRow cli="custom" text="security audit clear" color={roleColors.security} delay={74} local={local} />
          </div>
          <div style={styles.summaryFooter}>
            <span style={styles.summaryFooterCheck}>✓</span>
            Production-ready evidence captured
            <span style={styles.summaryFooterTime}>32m 18s</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function SceneHeading({ eyebrow, title, subtitle, progress }: { eyebrow: string; title: string; subtitle: string; progress: number }) {
  return (
    <div style={{ ...styles.sceneHeading, opacity: progress, transform: `translateY(${(1 - progress) * 18}px)` }}>
      <div style={styles.eyebrow}>{eyebrow}</div>
      <h1 style={styles.sceneTitle}>{title}</h1>
      <p style={styles.sceneSubtitle}>{subtitle}</p>
    </div>
  )
}

function BrandLockup() {
  return (
    <div style={styles.brand}>
      <MulticodeMark size={28} />
      <span style={styles.brandText}>multicode</span>
    </div>
  )
}

function MulticodeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`mark-left-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4f4f5" />
          <stop offset="100%" stopColor="#7a7a82" />
        </linearGradient>
        <linearGradient id={`mark-right-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9a9aa2" />
          <stop offset="100%" stopColor="#3a3a44" />
        </linearGradient>
      </defs>
      <path d="M4 3.5 16 13.5V28.5H4Z" fill={`url(#mark-left-${size})`} />
      <path d="M28 3.5 16 13.5V28.5H28Z" fill={`url(#mark-right-${size})`} />
      <path d="M16 13.5V28.5" stroke="#08090b" strokeWidth="0.5" strokeOpacity="0.6" />
    </svg>
  )
}

function RoleAvatar({ member, size }: { member: RosterMember; size: number }) {
  return (
    <span
      style={{
        ...styles.roleAvatar,
        width: size,
        height: size,
        color: member.color,
        borderColor: colorAlpha(member.color, 0.32),
        background: colorAlpha(member.color, 0.08),
        fontSize: size > 45 ? 15 : 10,
      }}
    >
      {member.initials}
    </span>
  )
}

function ModelSelector({ member, selected, frame, start }: { member: RosterMember; selected: boolean; frame: number; start: number }) {
  const pulse = interpolate(frame, [start, start + 12, start + 30], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  return (
    <div style={{ ...styles.modelSelector, borderColor: selected ? `rgba(63,148,104,${0.28 + pulse * 0.32})` : palette.border }}>
      <ProviderMonogram label={member.cli === 'Claude Code' ? 'C' : member.cli.slice(0, 1)} color={member.color} />
      <div>
        <div style={styles.selectorCli}>{member.cli}</div>
        <div style={styles.selectorModel}>{member.model}</div>
      </div>
      <span style={styles.selectorTag}>Architect model</span>
      <ChevronDown />
    </div>
  )
}

function ProviderMonogram({ label, color }: { label: string; color: string }) {
  return <span style={{ ...styles.providerMonogram, color, borderColor: colorAlpha(color, 0.3) }}>{label}</span>
}

function FlowConnector({ progress }: { progress: number }) {
  return (
    <div style={styles.flowConnector}>
      <div style={{ ...styles.flowLine, transform: `scaleX(${progress})` }} />
      <span style={{ ...styles.flowArrow, opacity: progress }}>›</span>
    </div>
  )
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={{ ...styles.metricValue, color: accent ? palette.greenBright : palette.ink }}>{value}</span>
    </div>
  )
}

function LegendItem({ kind, label }: { kind: 'ready' | 'running' | 'done'; label: string }) {
  return (
    <div style={styles.legendItem}>
      <span style={kind === 'ready' ? styles.legendReady : kind === 'running' ? styles.legendRunning : styles.legendDone}>
        {kind === 'done' ? '✓' : ''}
      </span>
      {label}
    </div>
  )
}

function NodeState({ state, frame }: { state: 'queued' | 'running' | 'done'; frame: number }) {
  if (state === 'done') return <span style={styles.nodeDone}>✓</span>
  if (state === 'running') return <Spinner frame={frame} />
  return <span style={styles.nodeQueued}>○</span>
}

function Spinner({ frame }: { frame: number }) {
  return (
    <span style={{ ...styles.spinner, transform: `rotate(${frame * 8}deg)` }}>
      <span style={styles.spinnerCutout} />
    </span>
  )
}

function LiveAgent({ name, model, state, color, active }: { name: string; model: string; state: string; color: string; active: boolean }) {
  return (
    <div style={styles.liveAgent}>
      <span style={{ ...styles.liveAgentGlyph, color, borderColor: colorAlpha(color, 0.28) }}>{name.slice(0, 2).toUpperCase()}</span>
      <div style={styles.liveAgentCopy}>
        <div style={styles.liveAgentName}>{name}</div>
        <div style={styles.liveAgentModel}>{model}</div>
      </div>
      <div style={styles.liveAgentState}>{active ? <span style={styles.liveMiniDot} /> : null}{state}</div>
    </div>
  )
}

function SummaryStat({ value, label }: { value: string; label: string }) {
  return (
    <div style={styles.summaryStat}>
      <div style={styles.summaryStatValue}>{value}</div>
      <div style={styles.summaryStatLabel}>{label}</div>
    </div>
  )
}

function TerminalRow({ cli, text, color, delay, local }: { cli: string; text: string; color: string; delay: number; local: number }) {
  const progress = enter(local, delay, 18)
  return (
    <div style={{ ...styles.terminalRow, opacity: progress, transform: `translateX(${(1 - progress) * 14}px)` }}>
      <span style={{ ...styles.terminalPrompt, color }}>$</span>
      <span style={styles.terminalCli}>{cli}</span>
      <span style={styles.terminalArrow}>›</span>
      <span style={styles.terminalText}>{text}</span>
      <span style={styles.terminalDone}>done</span>
    </div>
  )
}

function NavGlyph({ type, active }: { type: string; active: boolean }) {
  const color = active ? palette.greenBright : palette.muted
  if (type === 'Task graph') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 4 8 8m0 0 4-4M8 8v4" stroke={color} strokeWidth="1.3" />
        <circle cx="4" cy="4" r="2" stroke={color} strokeWidth="1.3" />
        <circle cx="12" cy="4" r="2" stroke={color} strokeWidth="1.3" />
        <circle cx="8" cy="12" r="2" stroke={color} strokeWidth="1.3" />
      </svg>
    )
  }
  if (type === 'Board') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke={color} strokeWidth="1.3" />
        <path d="M6.2 3v10M9.8 3v10" stroke={color} strokeWidth="1.1" />
      </svg>
    )
  }
  if (type === 'Roster') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="6" cy="5" r="2.2" stroke={color} strokeWidth="1.3" />
        <path d="M2.8 12c.4-2 1.6-3.1 3.2-3.1S8.8 10 9.2 12M10.2 4.3a2 2 0 0 1 0 3.5M10.4 9c1.4.1 2.4 1.1 2.8 2.7" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" stroke={color} strokeWidth="1.3" />
      <path d="m5.6 8 1.6 1.6 3.4-3.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TerminalGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="m4.5 6 1.8 1.6-1.8 1.6M8 10h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke={palette.greenBright} strokeWidth="1.2" />
      <path d="m5.3 8 1.7 1.7 3.8-3.9" stroke={palette.greenBright} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDown() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ArrowRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function visibleInRange(frame: number, start: number, end: number): number {
  return frame >= start && frame < end ? 1 : 0
}

function enter(frame: number, start: number, duration: number): number {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  })
}

function colorAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function graphWave(local: number): number {
  if (local < 38) return 0
  if (local < 82) return 1
  if (local < 132) return 2
  if (local < 182) return 3
  if (local < 222) return 4
  if (local < 258) return 5
  return 6
}

function graphNodeState(wave: number, local: number): 'queued' | 'running' | 'done' {
  const activeWave = graphWave(local)
  if (wave < activeWave) return 'done'
  if (wave === activeWave) return 'running'
  return 'queued'
}

function edgePath(from: GraphNode, to: GraphNode): string {
  const fromX = from.x + 96
  const toX = to.x - 96
  const control = (fromX + toX) / 2
  return `M ${fromX} ${from.y} C ${control} ${from.y}, ${control} ${to.y}, ${toX} ${to.y}`
}

function laneAt(task: BoardTask, local: number): BoardLane {
  let lane: BoardLane = task.steps[0][1]
  for (const [time, nextLane] of task.steps) {
    if (local >= time) lane = nextLane
  }
  return lane
}

function boardMovedAt(task: BoardTask, local: number): number {
  let movedAt = 0
  for (const [time] of task.steps) {
    if (local >= time) movedAt = time
  }
  return movedAt
}

const baseFont: CSSProperties = {
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  letterSpacing: '-0.011em',
}

const monoFont: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '-0.01em',
}

const styles: Record<string, CSSProperties> = {
  root: {
    ...baseFont,
    background: palette.app,
    color: palette.text,
  },
  grid: {
    position: 'absolute',
    inset: 0,
    opacity: 0.35,
    backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.035) 1px, transparent 1px)',
    backgroundSize: '56px 56px',
    maskImage: 'radial-gradient(ellipse at center, black 22%, transparent 76%)',
  },
  window: {
    position: 'absolute',
    inset: 58,
    overflow: 'hidden',
    borderRadius: 18,
    border: `1px solid ${palette.border}`,
    background: palette.app,
    boxShadow: '0 24px 68px rgba(0,0,0,0.28)',
  },
  topBar: {
    position: 'absolute',
    inset: '0 0 auto 0',
    height: 68,
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    borderBottom: `1px solid ${palette.borderSubtle}`,
    background: palette.app,
    zIndex: 5,
  },
  brand: { display: 'flex', alignItems: 'center', gap: 11 },
  brandText: { color: palette.ink, fontSize: 21, fontWeight: 650 },
  productName: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 34, paddingLeft: 22, borderLeft: `1px solid ${palette.border}`, color: palette.text, fontSize: 14, fontWeight: 550 },
  productDot: { width: 6, height: 6, borderRadius: 999, background: palette.gold },
  topSpacer: { flex: 1 },
  localLabel: { display: 'flex', alignItems: 'center', gap: 8, color: palette.muted, fontSize: 13 },
  sidebar: {
    position: 'absolute',
    zIndex: 4,
    top: 68,
    bottom: 0,
    left: 0,
    width: 208,
    padding: '22px 14px',
    borderRight: `1px solid ${palette.borderSubtle}`,
    background: '#0a0b0e',
  },
  sidebarHeading: { color: palette.ink, fontSize: 15, fontWeight: 620, padding: '0 10px 13px' },
  navItem: { height: 38, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', color: palette.muted, fontSize: 13, borderLeft: '3px solid transparent' },
  navActive: { height: 38, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', color: palette.ink, fontSize: 13, borderLeft: `3px solid ${palette.green}`, background: palette.greenSoft },
  sidebarSection: { color: palette.faint, fontSize: 11, margin: '26px 10px 12px' },
  sidebarAgent: { display: 'grid', gridTemplateColumns: '32px 1fr 8px', alignItems: 'center', gap: 9, padding: '8px 10px' },
  sidebarAvatar: { ...monoFont, display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center', border: `1px solid ${palette.border}`, borderRadius: 7, fontSize: 10, fontWeight: 700 },
  sidebarAgentName: { color: palette.text, fontSize: 11.5 },
  sidebarAgentMeta: { color: palette.faint, fontSize: 10.5, marginTop: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 999, background: palette.greenBright },
  sidebarMiniRows: { padding: '4px 10px 0' },
  sidebarMiniRow: { height: 28, display: 'flex', alignItems: 'center', gap: 8, color: palette.muted, fontSize: 11 },
  miniRoleBar: { width: 2, height: 12, borderRadius: 2 },
  sidebarBottom: { position: 'absolute', left: 18, right: 18, bottom: 22, display: 'flex', alignItems: 'center', gap: 10, paddingTop: 16, borderTop: `1px solid ${palette.borderSubtle}` },
  subscriptionStack: { display: 'flex' },
  stage: { position: 'absolute', zIndex: 1, top: 68, right: 0, bottom: 0, left: 208, overflow: 'hidden' },
  scene: { position: 'absolute', inset: 0, padding: '42px 48px' },
  sceneHeading: { maxWidth: 850 },
  eyebrow: { ...monoFont, color: palette.greenBright, fontSize: 12, marginBottom: 9 },
  sceneTitle: { color: palette.ink, fontSize: 42, lineHeight: 1.08, fontWeight: 680, margin: 0 },
  sceneSubtitle: { color: palette.muted, fontSize: 17, lineHeight: 1.45, margin: '12px 0 0' },
  compactTitle: { color: palette.ink, fontSize: 27, lineHeight: 1.18, fontWeight: 650 },
  sceneTopLine: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  rosterGrid: { display: 'grid', gridTemplateColumns: '0.76fr 1.55fr', gap: 20, marginTop: 28, height: 585 },
  architectCard: { border: `1px solid rgba(63,148,104,0.28)`, borderRadius: 12, background: palette.panel, padding: 22 },
  cardTopLine: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  primaryRoleLabel: { color: palette.text, fontSize: 12, fontWeight: 600 },
  premiumLabel: { ...monoFont, color: palette.warn, fontSize: 10.5 },
  architectIdentity: { display: 'flex', alignItems: 'center', gap: 16, marginTop: 26 },
  architectRole: { color: palette.ink, fontSize: 24, fontWeight: 650 },
  architectSummary: { color: palette.muted, fontSize: 12.5, lineHeight: 1.4, marginTop: 3 },
  modelSelector: { height: 74, marginTop: 24, border: '1px solid', borderRadius: 9, background: palette.raised, display: 'grid', gridTemplateColumns: '34px 1fr auto 16px', alignItems: 'center', gap: 12, padding: '0 13px' },
  providerMonogram: { ...monoFont, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid', borderRadius: 7, background: palette.panel, fontWeight: 750, fontSize: 11 },
  selectorCli: { color: palette.muted, fontSize: 10.5 },
  selectorModel: { color: palette.ink, fontSize: 14, fontWeight: 600, marginTop: 2 },
  selectorTag: { color: palette.greenBright, fontSize: 10.5 },
  architectResponsibilities: { marginTop: 26, paddingTop: 18, borderTop: `1px solid ${palette.borderSubtle}`, display: 'flex', flexDirection: 'column', gap: 13 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 9, color: palette.text, fontSize: 12.5 },
  specialistPanel: { border: `1px solid ${palette.borderSubtle}`, borderRadius: 12, background: palette.panel, padding: 20 },
  specialistHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  panelTitle: { color: palette.ink, fontSize: 16, fontWeight: 620 },
  panelSubtitle: { color: palette.muted, fontSize: 11.5, marginTop: 3 },
  agentCount: { ...monoFont, color: palette.muted, fontSize: 11 },
  specialistGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  rosterRow: { minHeight: 102, display: 'grid', gridTemplateColumns: '34px 1fr', gridTemplateRows: '1fr auto', gap: '0 10px', alignItems: 'center', border: '1px solid', borderRadius: 9, background: palette.raised, padding: '12px 13px' },
  roleAvatar: { ...monoFont, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: '1px solid', borderRadius: 8, fontWeight: 750 },
  rosterRoleBlock: { minWidth: 0 },
  rosterRole: { color: palette.ink, fontSize: 12.5, fontWeight: 570 },
  rosterResponsibility: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: palette.faint, fontSize: 10.5, marginTop: 3 },
  compactModel: { gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'auto 1fr 14px', alignItems: 'center', gap: 6, marginTop: 9, paddingTop: 8, borderTop: `1px solid ${palette.borderSubtle}`, color: palette.muted },
  cliName: { color: palette.muted, fontSize: 10 },
  modelName: { color: palette.text, fontSize: 10.5 },
  rosterFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  footerNote: { color: palette.faint, fontSize: 12 },
  primaryButton: { height: 42, display: 'flex', alignItems: 'center', gap: 9, padding: '0 17px', border: 0, borderRadius: 8, background: palette.green, color: palette.app, fontWeight: 700, fontSize: 13 },
  architectStatus: { display: 'flex', alignItems: 'center', gap: 9, color: palette.muted, fontSize: 11.5 },
  statusDivider: { width: 1, height: 14, background: palette.border },
  planFlow: { height: 610, marginTop: 52, display: 'grid', gridTemplateColumns: '320px 90px 190px 90px 1fr', alignItems: 'center' },
  goalCard: { alignSelf: 'center', border: `1px solid ${palette.border}`, borderRadius: 12, background: palette.raised, padding: 22 },
  goalLabel: { ...monoFont, color: palette.greenBright, fontSize: 10.5 },
  goalTitle: { color: palette.ink, fontSize: 22, fontWeight: 650, lineHeight: 1.2, marginTop: 12 },
  goalBody: { color: palette.muted, fontSize: 12.5, lineHeight: 1.55, marginTop: 12 },
  goalMeta: { color: palette.faint, fontSize: 10.5, lineHeight: 1.5, marginTop: 20, paddingTop: 15, borderTop: `1px solid ${palette.borderSubtle}` },
  flowConnector: { position: 'relative', height: 28, display: 'flex', alignItems: 'center' },
  flowLine: { width: '100%', height: 1, transformOrigin: 'left center', background: 'rgba(63,148,104,0.5)' },
  flowArrow: { position: 'absolute', right: -2, top: -1, color: palette.greenBright, fontSize: 22 },
  architectCore: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 236, border: `1px solid rgba(212,167,87,0.28)`, borderRadius: 12, background: palette.panel },
  coreRole: { color: palette.ink, fontSize: 17, fontWeight: 650, marginTop: 14 },
  coreModel: { ...monoFont, color: palette.warn, fontSize: 10.5, marginTop: 4 },
  coreActivity: { height: 26, display: 'flex', alignItems: 'center', gap: 7, marginTop: 16, color: palette.muted, fontSize: 10.5 },
  planDocument: { height: 500, alignSelf: 'center', border: `1px solid ${palette.border}`, borderRadius: 12, background: palette.panel, overflow: 'hidden' },
  documentHeader: { height: 76, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', borderBottom: `1px solid ${palette.borderSubtle}` },
  documentTitle: { color: palette.ink, fontSize: 16, fontWeight: 620 },
  documentMeta: { ...monoFont, color: palette.faint, fontSize: 10.5, marginTop: 4 },
  approvedLabel: { color: palette.greenBright, fontSize: 11 },
  planRows: { padding: 12 },
  planRow: { minHeight: 88, display: 'grid', gridTemplateColumns: '34px 1fr auto', alignItems: 'center', gap: 12, padding: '0 12px', borderBottom: `1px solid ${palette.borderSubtle}` },
  planNumber: { ...monoFont, color: palette.faint, fontSize: 11 },
  planRowTitle: { color: palette.text, fontSize: 13.5, fontWeight: 580 },
  planRowDetail: { color: palette.muted, fontSize: 11.5, marginTop: 4 },
  planTaskCount: { ...monoFont, color: palette.faint, fontSize: 10 },
  planFooter: { position: 'absolute', right: 48, bottom: 28, display: 'flex', alignItems: 'center', gap: 8, color: palette.muted, fontSize: 11.5 },
  graphHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' },
  graphMetrics: { display: 'flex', gap: 8 },
  metric: { minWidth: 106, height: 56, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 12px', border: `1px solid ${palette.border}`, borderRadius: 8, background: palette.panel },
  metricLabel: { color: palette.faint, fontSize: 9.5 },
  metricValue: { ...monoFont, fontSize: 16, marginTop: 4 },
  graphSurface: { position: 'absolute', left: 30, right: 30, top: 130, height: 720, overflow: 'hidden' },
  waveLabels: { position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' },
  waveLabel: { position: 'absolute', top: 8, width: 160, transform: 'translateX(-50%)', display: 'flex', justifyContent: 'space-between', color: palette.faint, fontSize: 9.5 },
  waveLabelActive: { color: palette.greenBright },
  graphEdges: { position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 0 },
  graphNode: { position: 'absolute', zIndex: 2, width: 192, minHeight: 104, padding: 13, border: '1px solid', borderRadius: 9 },
  nodeTop: { display: 'grid', gridTemplateColumns: '7px 1fr 14px', alignItems: 'center', gap: 7 },
  nodeRoleDot: { width: 6, height: 6, borderRadius: 2 },
  nodeRole: { color: palette.muted, fontSize: 9.5 },
  nodeTitle: { color: palette.ink, fontSize: 13, fontWeight: 600, lineHeight: 1.25, marginTop: 11 },
  nodeModel: { ...monoFont, color: palette.faint, fontSize: 9.5, marginTop: 7 },
  nodeDone: { color: palette.good, fontSize: 12, textAlign: 'right' },
  nodeQueued: { color: palette.faint, fontSize: 13, textAlign: 'right' },
  spinner: { position: 'relative', display: 'inline-block', width: 12, height: 12, borderRadius: 999, border: `2px solid ${palette.greenBright}`, borderRightColor: 'transparent' },
  spinnerCutout: { position: 'absolute', inset: 2, borderRadius: 999, background: 'transparent' },
  graphLegend: { position: 'absolute', left: 48, right: 48, bottom: 24, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 30, borderTop: `1px solid ${palette.borderSubtle}`, color: palette.muted, fontSize: 10.5 },
  legendItem: { display: 'flex', alignItems: 'center', gap: 8 },
  legendReady: { width: 11, height: 11, borderRadius: 999, border: `1px solid ${palette.muted}` },
  legendRunning: { width: 11, height: 11, borderRadius: 999, border: `2px solid ${palette.greenBright}`, borderRightColor: 'transparent' },
  legendDone: { width: 13, height: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', color: palette.good, fontSize: 11 },
  boardTop: { height: 68, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' },
  boardBody: { position: 'absolute', left: 34, right: 34, top: 126, bottom: 30, display: 'grid', gridTemplateColumns: '238px 1fr', gap: 12 },
  liveRoster: { border: `1px solid ${palette.borderSubtle}`, borderRadius: 10, background: palette.panel, padding: 14 },
  liveRosterTitle: { color: palette.ink, fontSize: 13, fontWeight: 620, marginBottom: 8 },
  liveAgent: { minHeight: 59, display: 'grid', gridTemplateColumns: '28px 1fr', gridTemplateRows: '1fr auto', alignItems: 'center', gap: '0 9px', padding: '6px 2px' },
  liveAgentGlyph: { ...monoFont, gridRow: '1 / 3', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid', borderRadius: 6, fontSize: 8.5, fontWeight: 700 },
  liveAgentCopy: { minWidth: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  liveAgentName: { color: palette.text, fontSize: 10.5 },
  liveAgentModel: { color: palette.faint, fontSize: 9 },
  liveAgentState: { display: 'flex', alignItems: 'center', gap: 5, color: palette.faint, fontSize: 9.5, marginTop: 2 },
  liveMiniDot: { width: 5, height: 5, borderRadius: 999, background: palette.greenBright },
  rosterRule: { height: 1, background: palette.borderSubtle, margin: '4px 0' },
  kanban: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 },
  boardLane: { minWidth: 0, border: `1px solid ${palette.borderSubtle}`, borderRadius: 10, background: palette.panel, padding: 9 },
  boardLaneHeader: { height: 30, display: 'flex', justifyContent: 'space-between', color: palette.text, fontSize: 11.5, fontWeight: 600 },
  laneCount: { ...monoFont, color: palette.faint, fontWeight: 400 },
  laneCards: { display: 'flex', flexDirection: 'column', gap: 7 },
  boardCard: { minHeight: 101, border: '1px solid', borderRadius: 8, padding: 10 },
  boardCardTop: { display: 'flex', justifyContent: 'space-between' },
  taskId: { ...monoFont, color: palette.faint, fontSize: 9 },
  cardRoleMark: { fontSize: 9 },
  boardCardTitle: { color: palette.ink, fontSize: 11.5, fontWeight: 570, lineHeight: 1.3, marginTop: 11 },
  boardCardMeta: { display: 'flex', justifyContent: 'space-between', color: palette.faint, fontSize: 8.8, marginTop: 14 },
  outcomeLayout: { height: '100%', display: 'grid', gridTemplateColumns: '0.93fr 1.07fr', gap: 76, alignItems: 'center' },
  outcomeCopy: { paddingLeft: 22 },
  outcomeTitle: { color: palette.ink, fontSize: 50, lineHeight: 1.06, fontWeight: 700, letterSpacing: '-0.035em', margin: '14px 0 0' },
  outcomeBody: { color: palette.muted, fontSize: 15.5, lineHeight: 1.55, maxWidth: 640, margin: '22px 0 0' },
  outcomeChecks: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 22px', marginTop: 30, maxWidth: 560 },
  outcomeCheck: { display: 'flex', alignItems: 'center', gap: 9, color: palette.text, fontSize: 12.5 },
  outcomeCheckIcon: { width: 19, height: 19, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid rgba(72,168,120,0.36)`, borderRadius: 999, color: palette.good, fontSize: 11 },
  finalLine: { marginTop: 34, paddingTop: 19, borderTop: `1px solid ${palette.borderSubtle}`, color: palette.greenBright, fontSize: 13.5, fontWeight: 570, maxWidth: 600 },
  summaryPanel: { minHeight: 590, border: `1px solid ${palette.border}`, borderRadius: 12, background: palette.panel, overflow: 'hidden' },
  summaryHeader: { height: 100, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', borderBottom: `1px solid ${palette.borderSubtle}` },
  summaryTitle: { color: palette.ink, fontSize: 20, fontWeight: 650 },
  summaryMeta: { color: palette.muted, fontSize: 11.5, marginTop: 5 },
  completeMark: { width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid rgba(72,168,120,0.4)`, borderRadius: 999, color: palette.good, fontSize: 19 },
  summaryStats: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderBottom: `1px solid ${palette.borderSubtle}` },
  summaryStat: { height: 106, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 22, borderRight: `1px solid ${palette.borderSubtle}` },
  summaryStatValue: { ...monoFont, color: palette.ink, fontSize: 24 },
  summaryStatLabel: { color: palette.faint, fontSize: 10.5, marginTop: 5 },
  terminalStack: { margin: 20, border: `1px solid ${palette.borderSubtle}`, borderRadius: 9, overflow: 'hidden', background: '#090a0c' },
  terminalRow: { height: 56, display: 'grid', gridTemplateColumns: '14px 58px 12px 1fr auto', alignItems: 'center', gap: 6, padding: '0 15px', borderBottom: `1px solid ${palette.borderSubtle}` },
  terminalPrompt: { ...monoFont, fontSize: 11, fontWeight: 700 },
  terminalCli: { ...monoFont, color: palette.text, fontSize: 10.5 },
  terminalArrow: { color: palette.faint, fontSize: 13 },
  terminalText: { ...monoFont, color: palette.muted, fontSize: 10 },
  terminalDone: { ...monoFont, color: palette.good, fontSize: 9.5 },
  summaryFooter: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 22px', color: palette.text, fontSize: 11.5 },
  summaryFooterCheck: { color: palette.good },
  summaryFooterTime: { ...monoFont, marginLeft: 'auto', color: palette.faint, fontSize: 10.5 },
}
