import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { ReviewGuideTerminal } from '../../../../../../shared/electron-api'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { ensureAgentTabInLayoutModel, flashAgentTab, focusOrAddAgentTab } from '../../../../utils/modelRegistry'
import { resolveGuideTerminal, type ResolvedGuideTerminal } from './reviewGuideTerminal'

// Opening the review guide's terminal from the Reviews door (MC-1783).
//
// The guide is a plain agent terminal in the review's project workspace, so
// "open it" is the ordinary reveal path — the same one the session manager and
// the Backlog "Open agent" action use: leave the door, activate the workspace,
// then focus (or add) the agent's tab. The one extra step is the AgentState:
// main spawns the pty under `sessionId === agentId`, and without a matching
// `workspace.agents` record the tab has nothing to reattach to. Writing it here
// from the reported coordinates is exactly what `WorkspaceManager.openSession`
// does when it adopts a session it did not start.

export interface GuideTerminalLink {
  // Null when the review's project is not open in this window — there is no
  // terminal to focus, so the caller withholds the link instead of opening an
  // empty tab.
  terminal: ResolvedGuideTerminal | null
  // Resolves once the reveal has been attempted; a session whose process has
  // already exited is left alone rather than re-armed for launch.
  open: () => Promise<void>
}

export function useGuideTerminal({
  reviewId,
  workspaceRoot,
  guide,
}: {
  reviewId: string | null
  workspaceRoot: string | null
  guide: ReviewGuideTerminal | null
}): GuideTerminalLink {
  // Only the id + folder of each workspace: shallow-compared so an unrelated
  // store tick (an agent's output, a projection refresh) does not re-render the
  // review canvas.
  const projects = useWorkspaceStore(
    useShallow((state) =>
      state.workspaces.map((workspace) => ({ id: workspace.id, folderPath: workspace.folderPath, mode: workspace.mode })),
    ),
  )
  const terminal = useMemo(
    () => resolveGuideTerminal({ reviewId, workspaceRoot, guide, workspaces: projects }),
    [reviewId, workspaceRoot, guide, projects],
  )

  const open = useCallback(async () => {
    if (!terminal) return
    const store = useWorkspaceStore.getState()
    const workspace = store.workspaces.find((candidate) => candidate.id === terminal.workspaceId)
    if (!workspace) return
    // The pty has to still be there. Callers only offer this while the guide is
    // working, so a dead session is the race (it exited between render and
    // click) — and writing launch flags for one is how a tab ends up trying to
    // relaunch a terminal nobody asked for. Same check `openSession` makes.
    const status = await window.api.terminalStatus(terminal.agentId).catch(() => null)
    if (!status?.processAlive) return
    store.updateAgent(workspace.id, terminal.agentId, {
      name: GUIDE_AGENT_NAME,
      cliSessionId: terminal.agentId,
      cliStartRequested: true,
      cliHasLaunched: true,
      // Only when something reported it: the agent record already carries the CLI
      // it was spawned with, and clearing that would relabel a running terminal.
      ...(terminal.cli ? { cli: terminal.cli } : {}),
    })
    // The door is a full-page surface over the workspace; it has to close before
    // the terminal underneath is visible.
    store.closeGlobalSurface()
    store.setActiveWorkspace(workspace.id)
    if (focusOrAddAgentTab(workspace.id, terminal.agentId, GUIDE_AGENT_NAME)) {
      flashAgentTab(workspace.id, terminal.agentId)
      return
    }
    try {
      // The workspace was cold: seed the tab into the persisted layout so it is
      // present when its layout model mounts, and latch the flash for then.
      store.updateLayout(workspace.id, ensureAgentTabInLayoutModel(workspace.layoutModel, terminal.agentId, GUIDE_AGENT_NAME))
      flashAgentTab(workspace.id, terminal.agentId)
    } catch {
      // The workspace is present but its layout could not take the tab; the
      // session manager still lists the guide, so this is not a dead end.
    }
  }, [terminal])

  return { terminal, open }
}

// Matches REVIEW_GUIDE_AGENT_NAME in src/main/review/guide-terminal-service.ts,
// which is the name the session was spawned with.
const GUIDE_AGENT_NAME = 'Review guide'
