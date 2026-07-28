import assert from 'node:assert/strict'

import { Model, TabNode, TabSetNode } from 'flexlayout-react'

import type { AgentCli, LayoutTemplate } from '../../../types/workspace'

// The board's "show me this agent" actions, against the condition that broke
// them: the board mounted on the Sprints door.
//
// A door is a full-page surface painted OVER the workspace layers, which stay
// mounted beneath it (WorkspaceManager). So an action that only asks the layout
// model to focus an agent tab reports success — the tab really is selected — and
// the operator sees absolutely nothing happen, because the door is still on top.
// The only reveal that works is the one that also activates the workspace, which
// is what clears `activeGlobalSurface`.
//
// The two halves are asserted separately, because the fix must not overreach:
// an explicit open leaves the door, and an automatic background launch must
// still NOT yank the operator off the surface they are reading.

// ── Preload bridge, installed before the store is imported (node has no window)
const terminalKills: string[] = []
const fakeWindow = {
  api: {
    terminalKill: async (sessionId: string) => {
      terminalKills.push(sessionId)
      return true
    },
    readSprintEngineAutomationMode: async () => ({ ok: true as const, record: null }),
    onSprintEngineAutomationChanged: () => () => undefined,
  },
  setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
}
;(globalThis as { window?: unknown }).window = fakeWindow

// Imported AFTER the fake window exists.
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { registerModel, unregisterModel } from '../../../utils/modelRegistry'
import { useSprintEngineBoardTerminalActions } from './useSprintEngineBoardTerminalActions'

const template: LayoutTemplate = {
  id: 'board-reveal-standard',
  name: 'Standard',
  description: 'Board agent-reveal test template',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: false },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [{ type: 'tab', name: 'Editor', component: 'editor' }],
        },
      ],
    },
  },
}

const AGENT_ID = 'developer-1'

function agentTab(model: Model, agentId: string): TabNode | null {
  let found: TabNode | null = null
  model.visitNodes((node) => {
    if (found || !(node instanceof TabNode) || node.getComponent() !== 'agent') return
    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) found = node
  })
  return found
}

function tabIsSelected(tab: TabNode): boolean {
  const parent = tab.getParent()
  return parent instanceof TabSetNode && parent.getSelectedNode()?.getId() === tab.getId()
}

/** The board's terminal actions over a live workspace, with only the injected
 *  collaborators the reveal paths actually touch stubbed out. */
function boardActions(workspaceId: string, liveSessionId: string | null) {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === workspaceId) ?? null
  return useSprintEngineBoardTerminalActions({
    workspaceId,
    workspace,
    agents: workspace?.agents ?? {},
    sprintEngineState: null,
    pluginCatalogEntries: [],
    rosterById: { [AGENT_ID]: { id: AGENT_ID, label: 'Developer 1', role: 'developer' } as never },
    architectAgentId: null,
    savedFolderPath: null,
    folderPath: '/repo/board-reveal',
    folderStatusMessage: null,
    folderCheckedPath: null,
    lastSelectedCli: 'claude' as AgentCli,
    recoveryDialog: null,
    updateAgent: (targetWorkspaceId, agentId, update) =>
      useWorkspaceStore.getState().updateAgent(targetWorkspaceId, agentId, update),
    recheckFolder: () => undefined,
    setSelectedAgentId: () => undefined,
    setCliPickerOpen: () => undefined,
    setRecoveryDialog: () => undefined,
    getAgentName: (_agentId, fallback) => fallback,
    getCustomAgentName: (_agentId, fallback) => fallback,
    getLiveAgentTerminalSession: () =>
      liveSessionId ? ({ sessionId: liveSessionId, cli: 'claude' } as never) : null,
  })
}

function main(): void {
  const store = () => useWorkspaceStore.getState()
  const workspaceId = store().addWorkspace(template, {
    name: 'Board reveal',
    folderPath: '/repo/board-reveal',
  })
  const workspace = store().workspaces.find((candidate) => candidate.id === workspaceId)
  assert.ok(workspace, 'the fixture workspace exists')
  const model = Model.fromJson(workspace.layoutModel)
  registerModel(workspaceId, model)

  // ── 1. A live agent, opened from the board while a door is on top ─────────
  store().openGlobalSurface('sprints')
  assert.equal(store().activeGlobalSurface, 'sprints', 'the board is being read on the door')

  boardActions(workspaceId, 'session-abc').openAgentTerminal(AGENT_ID)

  assert.equal(
    store().activeGlobalSurface,
    null,
    'opening an agent leaves the door — otherwise its tab is revealed behind an opaque full-page surface',
  )
  assert.equal(store().activeWorkspaceId, workspaceId, 'and lands on the agent’s own workspace')
  const opened = agentTab(model, AGENT_ID)
  assert.ok(opened, 'the agent’s terminal tab is in the layout')
  assert.ok(tabIsSelected(opened), 'and it is the selected tab in its tabset')
  assert.equal(
    (opened.getConfig() as { sessionId?: string } | undefined)?.sessionId,
    'session-abc',
    'carrying the live session the board already resolved, so the tab reattaches instead of relaunching',
  )
  assert.equal(
    opened.getClassName(),
    'agent-tab-spawn-flash',
    'and it flashes, so the revealed terminal is identifiable after the surface change',
  )
  console.log('ok - opening a live agent from a door-mounted board leaves the door and reveals the tab')

  // ── 2. Spawning from the same place behaves the same ──────────────────────
  store().openGlobalSurface('sprints')
  const spawnActions = boardActions(workspaceId, null)
  assert.equal(
    spawnActions.startAgentTerminal(AGENT_ID, 'Developer 1', 'claude' as AgentCli),
    true,
    'the launch itself succeeds',
  )
  assert.equal(
    store().activeGlobalSurface,
    null,
    'a foreground launch is an explicit "take me there" too — it leaves the door',
  )
  console.log('ok - a foreground launch leaves the door as well')

  // ── 3. …but an automatic background launch must not move the operator ─────
  store().openGlobalSurface('sprints')
  assert.equal(
    boardActions(workspaceId, null).startAgentTerminal(
      'developer-2',
      'Developer 2',
      'claude' as AgentCli,
      { reveal: 'background' },
    ),
    true,
  )
  assert.equal(
    store().activeGlobalSurface,
    'sprints',
    'an automatic respawn docks its tab silently and leaves the operator on the surface they are reading',
  )
  assert.ok(agentTab(model, 'developer-2'), 'the background tab is still docked')
  console.log('ok - a background launch docks the tab without leaving the door')

  unregisterModel(workspaceId)
  console.log('all board agent-reveal tests passed')
}

main()
