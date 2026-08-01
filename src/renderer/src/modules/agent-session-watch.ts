// Live agent-session observation for module renderers
// (RendererHost.watchAgentSessions): read-only views over the same
// terminal-sessions state the shell's own surfaces consume
// (useTerminalSessions / terminalSessionsStore). Ports are injected so the
// contract is unit-testable; modules/index wires the real store at boot.
//
// The view is deliberately narrow and enum-widened (strings), so shell
// vocabulary growth never breaks compiled modules. Snapshot + change events,
// deduped: a store emission that doesn't change the workspace's mapped views
// does not re-fire module callbacks.

export type ModuleAgentSessionView = {
  /** Multicode's terminal-tracking id (stable per session). */
  sessionId: string
  agentId: string | null
  /** Display name from spawn metadata, when known. */
  name: string | null
  /** Session kind, widened to string ('terminal', 'agent', …). */
  kind: string
  /** Owning orchestration system tag (e.g. 'sprintengine'), when the session belongs to one. */
  system: string | null
  /** The owning execution's id within its system, when the session belongs to one. */
  executionId: string | null
  /** True while the underlying process is alive (false when suspended/exited). */
  isLive: boolean
}

type SessionRecord = {
  sessionId: string
  workspaceId?: string
  agentId?: string
  agentName?: string
  kind: string
  processAlive: boolean
  agentSession?: { system?: string; executionId?: string }
}

export type AgentSessionWatchPorts = {
  getSessions: () => readonly SessionRecord[]
  /** Store subscription; cb fires on every sessions change. Returns unsubscribe. */
  subscribe: (cb: () => void) => () => void
}

export type AgentSessionWatcher = (
  workspaceId: string,
  cb: (sessions: ModuleAgentSessionView[]) => void
) => () => void

function toView(record: SessionRecord): ModuleAgentSessionView {
  return {
    sessionId: record.sessionId,
    agentId: record.agentId ?? null,
    name: record.agentName ?? null,
    kind: record.kind,
    system: record.agentSession?.system ?? null,
    executionId: record.agentSession?.executionId ?? null,
    isLive: record.processAlive === true,
  }
}

function viewsSignature(views: ModuleAgentSessionView[]): string {
  return views
    .map((view) => `${view.sessionId}\0${view.agentId}\0${view.name}\0${view.kind}\0${view.system}\0${view.executionId}\0${view.isLive}`)
    .join('\u0001')
}

export function createAgentSessionWatcher(ports: AgentSessionWatchPorts): AgentSessionWatcher {
  return (workspaceId, cb) => {
    const snapshot = (): ModuleAgentSessionView[] =>
      ports.getSessions()
        .filter((record) => record.workspaceId === workspaceId)
        .map(toView)

    let lastSignature: string | null = null
    const emit = (): void => {
      const views = snapshot()
      const signature = viewsSignature(views)
      if (signature === lastSignature) return
      lastSignature = signature
      try {
        cb(views)
      } catch (error) {
        // A throwing module callback must not break the store's emit loop.
        console.error('[modules] agent session watch callback threw:', error)
      }
    }

    const unsubscribe = ports.subscribe(emit)
    // Fires once with the current snapshot, then on change — same contract as
    // the Backlog watcher.
    emit()
    return unsubscribe
  }
}
