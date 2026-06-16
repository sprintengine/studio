import { AGENT_RUNTIME_MODULE_ID, buildAgentBacklogLink } from './agentBacklogLinks'
import { publishDiagnostic } from './diagnostics'
import { basename } from './paths'
import { toTitleName } from '../components/workspace/newWorkspace/helpers'
import { useWorkspaceStore } from '../store/workspaceStore'

// A readable item title from a `backlog/...` path, for the agent-side glyph
// tooltip when the caller has no scanned title (the drag-drop path). Strips the
// directory, the `.md`/`.html` extension, and a leading ISO date prefix.
export function backlogTitleFromRelativePath(relativePath: string): string {
  const name = basename(relativePath)
    .replace(/\.(md|html?)$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
  return toTitleName(name) || basename(relativePath)
}

// Record a Backlog item ↔ agent handoff on both sides, at the single moment the
// item is handed to an agent terminal (drag-drop or send-to-agent). Item side:
// the navigational `agent` link + supplementary module metadata, persisted
// through the Backlog service. Agent side: the back-reference that powers the
// terminal glyph. Best-effort: a recording failure surfaces as a diagnostic and
// never blocks or fails the handoff itself.
export async function recordBacklogAgentHandoff(input: {
  workspaceId: string
  workspaceRoot: string
  agentId: string
  relativePath: string
  // Supplied by callers that already hold the scanned item (BacklogPanel);
  // derived from the path otherwise (TerminalView drop).
  title?: string
}): Promise<void> {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === input.workspaceId)
  const agent = workspace?.agents[input.agentId]
  // The agent vanished between the paste and this write: nothing to link to.
  if (!agent) return

  const title = input.title?.trim() || backlogTitleFromRelativePath(input.relativePath)
  const linkedAt = Date.now()

  // Agent side first — a synchronous store write, so the terminal glyph appears
  // immediately on handoff rather than waiting on (or hostage to) the Backlog
  // service IPC below. Latest-wins.
  store.updateAgent(input.workspaceId, input.agentId, {
    backlogItemRef: { relativePath: input.relativePath, title, linkedAt },
  })

  // Item side — canonical, persisted, best-effort.
  try {
    const linkResult = await window.api.addOrUpdateBacklogLink({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.relativePath,
      link: buildAgentBacklogLink({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agentName: agent.name,
      }),
    })
    if (!linkResult.ok) throw new Error(linkResult.message)
    await window.api.updateBacklogModuleMetadata({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.relativePath,
      moduleId: AGENT_RUNTIME_MODULE_ID,
      value: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agentName: agent.name,
        cliSessionId: agent.cliSessionId,
        linkedAt,
      },
    })
  } catch (error) {
    void publishDiagnostic({
      level: 'warning',
      source: 'terminal',
      title: 'Could not link Backlog item to agent',
      message: `The handoff to ${agent.name} succeeded, but recording the Backlog link failed.`,
      details: [input.relativePath, error instanceof Error ? error.message : String(error)].join('\n'),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    })
  }
}
