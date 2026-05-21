import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'
import type { CSSProperties } from 'react'

const idea =
  'An internal knowledge base for engineering teams: page tree, inline comments, versioned drafts, fast search.'

const planLines = [
  '# Cairn - Page tree v2',
  'Goal: ship a versioned knowledge base for engineering teams.',
  'Scope',
  '- Page-version graph with branchable drafts',
  '- Inline-comment resolution flow',
  '- Fast search across pages and comments',
  '- SSO provisioning and audit events',
  '- Block editor with slash-command picker',
  'Roster',
  '11 agents across architecture, product, frontend, backend, review, QA, and security.',
  'First milestones',
  '1. Schema and versioning foundation',
  '2. Editor with comments',
  '3. Search and permissions',
  '4. SSO, audit, and release gate',
]

type LaneId = 'todo' | 'ready' | 'in_progress' | 'review' | 'testing' | 'done'

const lanes: { id: LaneId; label: string }[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'testing', label: 'Testing' },
  { id: 'done', label: 'Done' },
]

const tasks = [
  { id: 'CN-001', title: 'Version graph schema', role: 'developer' },
  { id: 'CN-005', title: 'Page tree navigation', role: 'frontend' },
  { id: 'CN-009', title: 'Inline comment anchors', role: 'developer' },
  { id: 'CN-013', title: 'Draft branch workflow', role: 'architect' },
  { id: 'CN-017', title: 'Search ranking model', role: 'performance' },
  { id: 'CN-021', title: 'SSO provisioning', role: 'security' },
  { id: 'CN-025', title: 'Slash-command picker', role: 'frontend' },
  { id: 'CN-029', title: 'Audit event export', role: 'devops' },
  { id: 'CN-033', title: 'Review evidence pack', role: 'code_reviewer' },
  { id: 'CN-039', title: 'Permission edge cases', role: 'tester' },
  { id: 'CN-044', title: 'Product acceptance notes', role: 'product' },
  { id: 'CN-054', title: 'Release checklist', role: 'spec_reviewer' },
]

const transitions: Array<{ frame: number; task: string; lane: LaneId }> = [
  { frame: 408, task: 'CN-001', lane: 'ready' },
  { frame: 420, task: 'CN-005', lane: 'ready' },
  { frame: 432, task: 'CN-009', lane: 'in_progress' },
  { frame: 444, task: 'CN-013', lane: 'in_progress' },
  { frame: 456, task: 'CN-001', lane: 'in_progress' },
  { frame: 470, task: 'CN-017', lane: 'ready' },
  { frame: 488, task: 'CN-005', lane: 'in_progress' },
  { frame: 504, task: 'CN-009', lane: 'review' },
  { frame: 520, task: 'CN-021', lane: 'ready' },
  { frame: 540, task: 'CN-001', lane: 'review' },
  { frame: 560, task: 'CN-025', lane: 'ready' },
  { frame: 580, task: 'CN-013', lane: 'review' },
  { frame: 600, task: 'CN-009', lane: 'testing' },
  { frame: 620, task: 'CN-029', lane: 'ready' },
  { frame: 640, task: 'CN-005', lane: 'review' },
  { frame: 660, task: 'CN-001', lane: 'testing' },
  { frame: 680, task: 'CN-013', lane: 'testing' },
  { frame: 700, task: 'CN-009', lane: 'done' },
  { frame: 720, task: 'CN-017', lane: 'in_progress' },
  { frame: 740, task: 'CN-001', lane: 'done' },
  { frame: 760, task: 'CN-005', lane: 'testing' },
  { frame: 780, task: 'CN-021', lane: 'in_progress' },
  { frame: 800, task: 'CN-013', lane: 'done' },
  { frame: 820, task: 'CN-025', lane: 'in_progress' },
  { frame: 840, task: 'CN-017', lane: 'review' },
  { frame: 860, task: 'CN-005', lane: 'done' },
  { frame: 880, task: 'CN-029', lane: 'in_progress' },
  { frame: 900, task: 'CN-021', lane: 'review' },
  { frame: 920, task: 'CN-017', lane: 'testing' },
  { frame: 940, task: 'CN-025', lane: 'review' },
  { frame: 965, task: 'CN-017', lane: 'done' },
  { frame: 985, task: 'CN-021', lane: 'testing' },
  { frame: 1005, task: 'CN-029', lane: 'review' },
]

const roster = [
  ['architect', 'planning'],
  ['product', 'acceptance'],
  ['developer-1', 'running'],
  ['developer-2', 'running'],
  ['frontend', 'running'],
  ['tester', 'gate'],
  ['security', 'review'],
  ['code-reviewer', 'gate'],
  ['spec-reviewer', 'queued'],
]

export function SprintEngineProductHero() {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  return (
    <AbsoluteFill style={styles.root}>
      <div style={styles.shell}>
        <TopBar />
        <WorkspaceSidebar />
        <div style={styles.stage}>
          <GuidedBriefScene frame={frame} fps={fps} />
          <PlanScene frame={frame} />
          <BoardScene frame={frame} />
        </div>
      </div>
    </AbsoluteFill>
  )
}

function TopBar() {
  return (
    <div style={styles.topBar}>
      <BrandLockup />
      <div style={styles.topTabs}>
        <span style={styles.tabActive}>Sprint Engine</span>
        <span style={styles.tab}>Switchboard</span>
        <span style={styles.tab}>Multiloop</span>
      </div>
      <div style={styles.topRight}>Local workspace</div>
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

function WorkspaceSidebar() {
  return (
    <aside style={styles.sidebar}>
      <div style={styles.sidebarLabel}>Workspaces</div>
      <div style={styles.workspaceItemActive}>
        <span style={styles.workspaceDot} />
        <span>Cairn sprint</span>
      </div>
      <div style={styles.workspaceItem}>Mobile bridge</div>
      <div style={styles.workspaceItem}>Billing console</div>
      <div style={styles.sidebarFooter}>
        <MulticodeMark size={58} />
      </div>
    </aside>
  )
}

function GuidedBriefScene({ frame, fps }: { frame: number; fps: number }) {
  const opacity = interpolate(frame, [0, 118, 144], [1, 1, 0], { extrapolateRight: 'clamp' })
  const scale = interpolate(frame, [118, 144], [1, 0.96], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const typed = idea.slice(0, Math.floor(interpolate(frame, [12, 94], [0, idea.length], { extrapolateRight: 'clamp' })))
  const cursorX = interpolate(frame, [0, 16, 96, 112], [1180, 845, 845, 1035], { extrapolateRight: 'clamp' })
  const cursorY = interpolate(frame, [0, 16, 96, 112], [750, 395, 548, 664], { extrapolateRight: 'clamp' })
  const clickScale = spring({ frame: frame - 106, fps, config: { damping: 14, stiffness: 220 } })

  return (
    <div style={{ ...styles.scene, opacity }}>
      <div style={styles.dimmedApp}>
        <BoardPreviewMuted />
      </div>
      <div style={{ ...styles.dialog, transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div style={styles.dialogKicker}>Guided brief</div>
        <h1 style={styles.dialogTitle}>What are we building?</h1>
        <div style={styles.fieldLabel}>Rough idea</div>
        <div style={styles.textArea}>
          {typed}
          <span style={styles.caret} />
        </div>
        <div style={styles.choiceRow}>
          <div style={styles.choiceActive}>Yes, it has a UI</div>
          <div style={styles.choice}>No, script or service</div>
        </div>
        <div style={styles.dialogBottom}>
          <span>Idea seed will become the Sprint Engine handoff.</span>
          <button style={{ ...styles.primaryButton, transform: `scale(${1 + clickScale * 0.015})` }}>Continue</button>
        </div>
      </div>
      <Cursor x={cursorX} y={cursorY} />
    </div>
  )
}

function PlanScene({ frame }: { frame: number }) {
  const enter = interpolate(frame, [132, 160], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const exit = interpolate(frame, [340, 390], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const opacity = enter * exit
  const translate = interpolate(frame, [132, 160], [40, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const visibleLines = Math.floor(interpolate(frame, [162, 334], [0, planLines.length], { extrapolateRight: 'clamp' }))

  return (
    <div style={{ ...styles.scene, opacity, transform: `translateY(${translate}px)` }}>
      <div style={styles.planPanel}>
        <div style={styles.panelHeader}>
          <span style={styles.panelDot} />
          <span>Architect plan</span>
          <span style={styles.panelPath}>product/brief-to-sprint.md</span>
        </div>
        <div style={styles.planBody}>
          {planLines.slice(0, visibleLines).map((line) => (
            <div
              key={line}
              style={{
                ...styles.planLine,
                ...(line.startsWith('#') ? styles.planHeading : {}),
                ...(line.startsWith('-') || /^\d\./.test(line) ? styles.planBullet : {}),
              }}
            >
              {line}
            </div>
          ))}
          {visibleLines < planLines.length ? <span style={styles.caret} /> : null}
        </div>
      </div>
    </div>
  )
}

function BoardScene({ frame }: { frame: number }) {
  const opacity = interpolate(frame, [360, 402], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const laneTasks = tasks.map((task) => ({
    ...task,
    lane: laneForTask(task.id, frame),
    movedAt: lastMoveFrame(task.id, frame),
  }))
  const doneCount = laneTasks.filter((task) => task.lane === 'done').length
  const activeCount = laneTasks.filter((task) => task.lane === 'in_progress' || task.lane === 'review' || task.lane === 'testing').length

  return (
    <div style={{ ...styles.scene, opacity }}>
      <div style={styles.boardLayout}>
        <div style={styles.rosterRail}>
          <div style={styles.railHeader}>Roster</div>
          {roster.map(([name, state], index) => (
            <div key={name} style={styles.agentRow}>
              <span style={{ ...styles.agentAvatar, background: roleColor(index) }}>{name.slice(0, 2).toUpperCase()}</span>
              <div>
                <div style={styles.agentName}>{name}</div>
                <div style={styles.agentState}>{state}</div>
              </div>
              <span style={state === 'running' || state === 'gate' ? styles.agentPulse : styles.agentIdle} />
            </div>
          ))}
        </div>
        <div style={styles.boardPanel}>
          <div style={styles.boardHeader}>
            <div>
              <div style={styles.boardKicker}>Sprint Engine</div>
              <div style={styles.boardTitle}>Cairn page tree sprint</div>
            </div>
            <div style={styles.metrics}>
              <Metric label="Active" value={String(activeCount)} />
              <Metric label="Done" value={String(doneCount)} />
              <Metric
                label="Gates"
                value={`${Math.min(
                  16,
                  Math.floor(
                    interpolate(frame, [430, 1000], [0, 15], {
                      extrapolateLeft: 'clamp',
                      extrapolateRight: 'clamp',
                    }),
                  ),
                )}/16`}
              />
            </div>
          </div>
          <div style={styles.lanes}>
            {lanes.map((lane) => {
              const inLane = laneTasks.filter((task) => task.lane === lane.id)
              return (
                <div key={lane.id} style={styles.lane}>
                  <div style={styles.laneHeader}>
                    <span>{lane.label}</span>
                    <span style={styles.laneCount}>{inLane.length}</span>
                  </div>
                  <div style={styles.cards}>
                    {inLane.map((task, index) => (
                      <TaskCard key={task.id} task={task} index={index} frame={frame} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function BoardPreviewMuted() {
  return (
    <div style={styles.previewBoard}>
      {lanes.slice(0, 5).map((lane, laneIndex) => (
        <div key={lane.id} style={styles.previewLane}>
          <div style={styles.previewLine} />
          {[0, 1, 2].map((item) => (
            <div key={item} style={{ ...styles.previewCard, opacity: 0.28 + laneIndex * 0.05 }} />
          ))}
        </div>
      ))}
    </div>
  )
}

function TaskCard({
  task,
  index,
  frame,
}: {
  task: { id: string; title: string; role: string; movedAt: number | null }
  index: number
  frame: number
}) {
  const materialize = interpolate(frame, [386 + index * 5, 410 + index * 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const moved = task.movedAt ? Math.max(0, 1 - (frame - task.movedAt) / 24) : 0

  return (
    <div
      style={{
        ...styles.taskCard,
        opacity: materialize,
        transform: `translateY(${(1 - materialize) * 16}px)`,
        borderColor: moved > 0 ? `rgba(255, 191, 47, ${0.18 + moved * 0.42})` : 'rgba(255,255,255,0.08)',
        boxShadow: moved > 0 ? `0 0 ${24 * moved}px rgba(255,191,47,${0.16 * moved})` : 'none',
      }}
    >
      <div style={styles.taskTop}>
        <span style={styles.taskId}>{task.id}</span>
        <span style={styles.taskRole}>{task.role}</span>
      </div>
      <div style={styles.taskTitle}>{task.title}</div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={styles.metricValue}>{value}</span>
    </div>
  )
}

function Cursor({ x, y }: { x: number; y: number }) {
  return (
    <svg style={{ ...styles.cursor, transform: `translate(${x}px, ${y}px)` }} width="34" height="42" viewBox="0 0 34 42">
      <path d="M3 3L28 27H15L10 39L3 3Z" fill="#f4f4f5" stroke="#08090b" strokeWidth="2" />
    </svg>
  )
}

function MulticodeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`mc-left-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4f4f5" />
          <stop offset="100%" stopColor="#7a7a82" />
        </linearGradient>
        <linearGradient id={`mc-right-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9a9aa2" />
          <stop offset="100%" stopColor="#3a3a44" />
        </linearGradient>
      </defs>
      <path d="M4 3.5 L16 13.5 L16 28.5 L4 28.5 Z" fill={`url(#mc-left-${size})`} />
      <path d="M28 3.5 L16 13.5 L16 28.5 L28 28.5 Z" fill={`url(#mc-right-${size})`} />
      <path d="M16 13.5 L16 28.5" stroke="#08090b" strokeWidth="0.4" strokeOpacity="0.6" />
    </svg>
  )
}

function laneForTask(taskId: string, frame: number): LaneId {
  let lane: LaneId = 'todo'
  for (const transition of transitions) {
    if (transition.task === taskId && frame >= transition.frame) lane = transition.lane
  }
  return lane
}

function lastMoveFrame(taskId: string, frame: number): number | null {
  let movedAt: number | null = null
  for (const transition of transitions) {
    if (transition.task === taskId && frame >= transition.frame) movedAt = transition.frame
  }
  return movedAt
}

function roleColor(index: number): string {
  return ['#d4a757', '#e879a7', '#c7ccd4', '#39d7ff', '#3dff8f', '#ff6b6b', '#f59e0b', '#22c55e', '#a78bfa'][index % 9]
}

const baseFont: CSSProperties = {
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  letterSpacing: 0,
}

const monoFont: CSSProperties = {
  fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  letterSpacing: 0,
}

const styles: Record<string, CSSProperties> = {
  root: {
    ...baseFont,
    background: '#06070a',
    color: '#c7c8cf',
  },
  shell: {
    position: 'absolute',
    inset: 58,
    overflow: 'hidden',
    borderRadius: 24,
    border: '1px solid rgba(255,255,255,0.08)',
    background: '#08090b',
    boxShadow: '0 40px 140px rgba(0,0,0,0.48)',
  },
  topBar: {
    position: 'absolute',
    inset: '0 0 auto 0',
    height: 72,
    display: 'flex',
    alignItems: 'center',
    gap: 34,
    padding: '0 26px',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: '#08090b',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 12 },
  brandText: { color: '#f4f4f5', fontWeight: 650, fontSize: 24 },
  topTabs: { display: 'flex', gap: 8 },
  tabActive: { padding: '8px 13px', borderRadius: 8, background: 'rgba(255,255,255,0.07)', color: '#f4f4f5', fontSize: 15 },
  tab: { padding: '8px 13px', borderRadius: 8, color: '#8d8f98', fontSize: 15 },
  topRight: { marginLeft: 'auto', color: '#9a9aa2', fontSize: 14 },
  sidebar: {
    position: 'absolute',
    top: 72,
    bottom: 0,
    left: 0,
    width: 238,
    padding: 20,
    borderRight: '1px solid rgba(255,255,255,0.07)',
    background: '#0b0c10',
  },
  sidebarLabel: { color: '#6f7078', fontSize: 12, marginBottom: 14, textTransform: 'uppercase' },
  workspaceItemActive: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 11px',
    borderRadius: 8,
    background: 'rgba(92,124,255,0.16)',
    color: '#f4f4f5',
    fontSize: 14,
  },
  workspaceDot: { width: 7, height: 7, borderRadius: 999, background: '#ffbf2f' },
  workspaceItem: { padding: '10px 11px', color: '#7b7d86', fontSize: 14 },
  sidebarFooter: { position: 'absolute', bottom: 26, left: 88, opacity: 0.22 },
  stage: { position: 'absolute', top: 72, right: 0, bottom: 0, left: 238 },
  scene: { position: 'absolute', inset: 0 },
  dimmedApp: { position: 'absolute', inset: 0, opacity: 0.34 },
  previewBoard: { position: 'absolute', inset: 46, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 },
  previewLane: { border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 12, background: '#0d0e11' },
  previewLine: { width: '48%', height: 10, borderRadius: 999, background: 'rgba(255,255,255,0.12)', marginBottom: 18 },
  previewCard: { height: 86, borderRadius: 8, background: 'rgba(255,255,255,0.08)', marginBottom: 10 },
  dialog: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 660,
    padding: 30,
    borderRadius: 18,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(16,19,26,0.94)',
    boxShadow: '0 34px 110px rgba(0,0,0,0.56)',
  },
  dialogKicker: { ...monoFont, color: '#f5c451', fontSize: 13, marginBottom: 10 },
  dialogTitle: { color: '#f4f4f5', fontSize: 34, margin: 0, marginBottom: 24 },
  fieldLabel: { color: '#9a9aa2', fontSize: 13, marginBottom: 8 },
  textArea: {
    minHeight: 142,
    padding: 16,
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.09)',
    background: '#08090b',
    color: '#e4e4e7',
    fontSize: 18,
    lineHeight: 1.5,
  },
  caret: { display: 'inline-block', width: 8, height: 20, marginLeft: 3, background: '#f5c451', verticalAlign: 'text-bottom' },
  choiceRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 18 },
  choiceActive: { padding: 14, borderRadius: 10, border: '1px solid rgba(245,196,81,0.48)', background: 'rgba(245,196,81,0.10)', color: '#fff0b0' },
  choice: { padding: 14, borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', color: '#9a9aa2' },
  dialogBottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22, color: '#6f7078', fontSize: 13 },
  primaryButton: {
    border: 0,
    borderRadius: 10,
    padding: '12px 18px',
    background: 'linear-gradient(180deg, #ffe07a, #e0a92a)',
    color: '#06070a',
    fontWeight: 700,
    fontSize: 15,
  },
  cursor: { position: 'absolute', left: 0, top: 0, filter: 'drop-shadow(0 5px 12px rgba(0,0,0,0.45))' },
  planPanel: {
    position: 'absolute',
    left: 80,
    right: 80,
    top: 62,
    bottom: 62,
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.08)',
    background: '#0d0e11',
    overflow: 'hidden',
  },
  panelHeader: { height: 58, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px', color: '#f4f4f5', borderBottom: '1px solid rgba(255,255,255,0.07)' },
  panelDot: { width: 8, height: 8, borderRadius: 999, background: '#ffbf2f' },
  panelPath: { ...monoFont, color: '#6f7078', fontSize: 12, marginLeft: 'auto' },
  planBody: { padding: '30px 36px' },
  planLine: { color: '#c7c8cf', fontSize: 22, lineHeight: 1.64 },
  planHeading: { color: '#f4f4f5', fontSize: 34, fontWeight: 700, marginBottom: 10 },
  planBullet: { color: '#d7d8df', paddingLeft: 16 },
  boardLayout: { position: 'absolute', inset: 34, display: 'grid', gridTemplateColumns: '250px 1fr', gap: 16 },
  rosterRail: { border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 14, background: '#0d0e11' },
  railHeader: { color: '#f4f4f5', fontWeight: 650, fontSize: 17, marginBottom: 13 },
  agentRow: { display: 'grid', gridTemplateColumns: '34px 1fr 9px', gap: 10, alignItems: 'center', padding: '9px 4px' },
  agentAvatar: { width: 34, height: 34, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#08090b', fontSize: 11, fontWeight: 800 },
  agentName: { color: '#e4e4e7', fontSize: 13 },
  agentState: { color: '#7b7d86', fontSize: 11 },
  agentPulse: { width: 9, height: 9, borderRadius: 999, background: '#30d158', boxShadow: '0 0 16px rgba(48,209,88,0.9)' },
  agentIdle: { width: 8, height: 8, borderRadius: 999, background: '#5a5a63' },
  boardPanel: { border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, background: '#0b0c10', padding: 16 },
  boardHeader: { height: 72, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  boardKicker: { ...monoFont, color: '#ffbf2f', fontSize: 12 },
  boardTitle: { color: '#f4f4f5', fontSize: 24, fontWeight: 700, marginTop: 2 },
  metrics: { display: 'flex', gap: 10 },
  metric: { minWidth: 88, padding: '8px 10px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 9, background: '#111216' },
  metricLabel: { color: '#7b7d86', fontSize: 11, display: 'block' },
  metricValue: { ...monoFont, color: '#f4f4f5', fontSize: 17 },
  lanes: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, height: 'calc(100% - 72px)' },
  lane: { border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, background: '#0d0e11', padding: 9, minWidth: 0 },
  laneHeader: { display: 'flex', justifyContent: 'space-between', color: '#c7c8cf', fontWeight: 650, fontSize: 13, marginBottom: 10 },
  laneCount: { ...monoFont, color: '#6f7078', fontWeight: 400 },
  cards: { display: 'flex', flexDirection: 'column', gap: 8 },
  taskCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, background: '#111216', padding: 10 },
  taskTop: { display: 'flex', justifyContent: 'space-between', marginBottom: 7 },
  taskId: { ...monoFont, color: '#8d8f98', fontSize: 10 },
  taskRole: { color: '#6f7078', fontSize: 10 },
  taskTitle: { color: '#f4f4f5', fontSize: 12.5, lineHeight: 1.3 },
}
