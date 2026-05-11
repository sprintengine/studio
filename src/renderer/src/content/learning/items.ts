import type { LearningItem } from './types'

export const LEARNING_ITEMS: readonly LearningItem[] = [
  {
    id: 'workspace.drag-terminal-into-workspace',
    title: 'Drag a terminal into a workspace',
    summary: 'Keep an agent session attached to the work it belongs to.',
    body: 'Drag a terminal tab onto another workspace in the sidebar to move the session — its agent, logs, and prompt history travel with it. Use it when a side investigation grows into its own deliverable.',
    category: 'workspace',
    difficulty: 'basic',
    action: { label: 'Open Learn Center', kind: 'open-learn-center' },
  },
  {
    id: 'workspace.drop-file-into-terminal',
    title: 'Drop a file into a terminal',
    summary: 'Hand an agent concrete context without retyping paths.',
    body: 'Drag a file from the file explorer onto a terminal tab. Multicode pastes the absolute path so your agent can read, edit, or run it — no copy/paste shuffling.',
    category: 'workspace',
    difficulty: 'basic',
  },
  {
    id: 'agents.spawn-specialist',
    title: 'Use specialist roles for high-judgment work',
    summary: 'Architecture, frontend, QA, security, performance, and review each have a Soul.',
    body: 'When the task needs judgment beyond a generic chat, spawn a specialist. Each specialist loads a role-specific Soul, picks a sensible CLI runtime, and applies the right permission preset before it starts.',
    category: 'agents',
    difficulty: 'basic',
    action: { label: 'Open Learn Center', kind: 'open-learn-center' },
  },
  {
    id: 'sprintengine.check-evidence',
    title: 'Check evidence before treating a task as done',
    summary: 'Sprint Engine surfaces gate state, attempts, and artifacts in the detail pane.',
    body: 'Open the Sprint Engine board, select a task, and read the Attempts timeline and gate evidence. A green column is not enough — confirm the artifacts the agent produced before you ship.',
    category: 'sprintengine',
    difficulty: 'intermediate',
  },
  {
    id: 'switchboard.watchtower-to-inbox',
    title: 'Turn review findings into Switchboard tasks',
    summary: 'Watchtower promotes review hits into the Switchboard inbox.',
    body: 'When Watchtower finishes a review pass, promote each finding to the Switchboard inbox so it gets ranked and routed like any other task instead of living in a transient run log.',
    category: 'switchboard',
    difficulty: 'intermediate',
  },
  {
    id: 'knowledge.configure-graph-root',
    title: 'Configure the Knowledge Graph',
    summary: 'Give agents product, brand, and architecture context before they edit.',
    body: 'In Settings → Knowledge Graph, point Multicode at a relative folder under your project. Agents will read product, architecture, and brand notes from there before they touch code.',
    category: 'knowledge',
    difficulty: 'basic',
    action: {
      label: 'Open Knowledge Graph settings',
      kind: 'open-settings-tab',
      args: { tab: 'knowledge-graph' },
    },
  },
  {
    id: 'knowledge.install-workspace-skill',
    title: 'Install the workspace-knowledge skill',
    summary: 'Agents need the skill installed before they can read and update your graph.',
    body: 'Once the Knowledge Graph root is set, install the workspace-knowledge built-in skill from the same settings tab. Agents will use it to fetch and update knowledge instead of guessing.',
    category: 'knowledge',
    difficulty: 'basic',
    action: {
      label: 'Open Knowledge Graph settings',
      kind: 'open-settings-tab',
      args: { tab: 'knowledge-graph' },
    },
  },
  {
    id: 'local-safety.prefer-worktrees',
    title: 'Prefer worktrees when agents touch code',
    summary: 'Multiple agents working in parallel should run in their own checkout.',
    body: 'When you spawn an agent, choose the worktree execution mode if any other agent might touch the same branch. Multicode isolates each run so failing experiments do not stomp on each other.',
    category: 'local-safety',
    difficulty: 'intermediate',
  },
  {
    id: 'local-safety.permission-presets',
    title: 'Pick permission presets intentionally',
    summary: 'Default, plan-only, and full-auto change what the agent is allowed to do.',
    body: 'Before you launch a terminal agent, glance at the permission preset chip. Default asks before destructive moves; full-auto skips the prompts. Match the preset to how much you trust the task description.',
    category: 'local-safety',
    difficulty: 'intermediate',
  },
  {
    id: 'local-safety.keep-terminals-visible',
    title: 'Keep terminals visible',
    summary: 'Failed commands and blocked prompts are obvious when the session is on screen.',
    body: 'Drag the relevant terminals into the active workspace layout instead of hiding them behind tabs. Local-first delivery only works when you can see what each agent is doing — and what it is stuck on.',
    category: 'local-safety',
    difficulty: 'basic',
  },
  {
    id: 'workspace.command-palette',
    title: 'Open the command palette',
    summary: 'Most workspace, agent, and settings actions are reachable from one place.',
    body: 'Press ⌘K (Ctrl+K on Windows/Linux) to open the command palette. Spawn agents, switch workspaces, open settings tabs, and jump between layouts without leaving the keyboard.',
    category: 'workspace',
    difficulty: 'basic',
  },
  {
    id: 'workspace.sidebar-toggle',
    title: 'Toggle the sidebar with ⌘B',
    summary: 'Reclaim screen real estate when terminals and editors need room.',
    body: 'Use ⌘B to collapse the workspace sidebar to an icon rail. The rail still shows active workspaces and the running/needs-input dots so you do not lose situational awareness.',
    category: 'workspace',
    difficulty: 'basic',
  },
] as const

export function getLearningItemById(id: string): LearningItem | undefined {
  return LEARNING_ITEMS.find((item) => item.id === id)
}

function assertUniqueLearningIds(): void {
  const seen = new Set<string>()
  for (const item of LEARNING_ITEMS) {
    if (seen.has(item.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[learning] duplicate id: ${item.id}`)
    }
    seen.add(item.id)
  }
}

assertUniqueLearningIds()
