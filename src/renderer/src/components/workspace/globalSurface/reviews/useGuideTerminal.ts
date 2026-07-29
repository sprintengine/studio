import { useCallback, useMemo } from 'react'

import type { ReviewGuideTerminal } from '../../../../../../shared/electron-api'
import { useTerminalSessions } from '../../../../hooks/useTerminalSessions'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { ensureAgentTabInLayoutModel, flashAgentTab, focusOrAddAgentTab } from '../../../../utils/modelRegistry'
import { resolveGuideTerminal, type ResolvedGuideTerminal } from './reviewGuideTerminal'

// Opening the review guide's terminal from the Reviews door (MC-1783).
//
// The guide is a plain agent terminal in the project's Reviews-host workspace,
// so "open it" is the ordinary reveal path — the same one the session manager
// and the Backlog "Open agent" action use: leave the door, activate the
// workspace, then focus (or add) the agent's tab. The one extra step is the
// AgentState: without a matching `workspace.agents` record carrying the pty's
// session id, the tab has nothing to reattach to. Writing it here from the live
// session's coordinates is exactly what `WorkspaceManager.openSession` does when
// it adopts a session it did not start.

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
  guide,
}: {
  reviewId: string | null
  guide: ReviewGuideTerminal | null
}): GuideTerminalLink {
  // The live terminal sessions are the source of truth for where the guide is
  // and what pty to attach to. Deliberately NOT a workspace-store selector: the
  // store view this used to build had to be flattened to primitives to stop an
  // infinite re-render loop on mount (MC-1834), and the session snapshot is
  // both dedup-stable and the thing actually being asked about.
  const sessions = useTerminalSessions()
  const terminal = useMemo(
    () => resolveGuideTerminal({ reviewId, guide, sessions }),
    [reviewId, guide, sessions],
  )

  const open = useCallback(async () => {
    if (!terminal?.sessionId) return
    const store = useWorkspaceStore.getState()
    const workspace = store.workspaces.find((candidate) => candidate.id === terminal.workspaceId)
    if (!workspace) return
    // The pty has to still be there. Callers only offer this while the guide is
    // working, so a dead session is the race (it exited between render and
    // click) — and writing launch flags for one is how a tab ends up trying to
    // relaunch a terminal nobody asked for. Same check `openSession` makes.
    const status = await window.api.terminalStatus(terminal.sessionId).catch(() => null)
    if (!status?.processAlive) return
    store.updateAgent(workspace.id, terminal.agentId, {
      name: GUIDE_AGENT_NAME,
      // The pty's own id, which is what the tab attaches by. It is also the
      // resume token for a Claude-harness CLI, which is why it must be the id
      // the guide was really launched with rather than anything derived here.
      cliSessionId: terminal.sessionId,
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
