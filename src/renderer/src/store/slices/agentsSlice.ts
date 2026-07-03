import { detectLanguage } from '../../utils/files'
import {
  deleteEditorBuffer,
  remapEditorBuffers,
  removeEditorBuffersForPath,
  setEditorBuffer,
} from '../../utils/editorBuffers'
import { pickRandomAgentName } from '../../utils/agentNames'
import {
  agentCliSupportsConversationResume,
} from '../../utils/agentCliResume'
import { normalizeCliPermissionPreset } from './settingsSlice'
import type {
  AgentTerminalLaunchStateApply,
  AgentTerminalSessionApply,
} from '../workspaceSyncClient'
import type {
  AgentCli,
  AgentConversationRuntime,
  AgentExecution,
  AgentId,
  AgentKind,
  AgentRuntimeKind,
  AgentState,
  EditorState,
  Workspace,
  WorkspaceId,
} from '../../types/workspace'

export const defaultAgentExecution = (): AgentExecution => ({
  mode: 'current_workspace',
  worktreeId: null,
  cwd: null,
})

export function normalizeAgentExecution(input: Partial<AgentExecution> | null | undefined): AgentExecution {
  const mode = input?.mode === 'worktree' ? 'worktree' : 'current_workspace'
  const worktreeId = typeof input?.worktreeId === 'string' && input.worktreeId.trim()
    ? input.worktreeId.trim()
    : null
  const cwd = typeof input?.cwd === 'string' && input.cwd.trim()
    ? input.cwd
    : null

  if (mode === 'current_workspace') return defaultAgentExecution()

  return {
    mode,
    worktreeId,
    cwd,
  }
}

export const defaultAgent = (id: AgentId, name = id, kind: AgentKind = 'general'): AgentState => ({
  id,
  name,
  status: 'idle',
  execution: defaultAgentExecution(),
  messages: [],
  streamBuffer: '',
  runtimeKind: 'terminal',
  conversation: undefined,
  cliSessionId: undefined,
  harnessSessionId: undefined,
  cliStartRequested: false,
  cliRestartNonce: 0,
  cliHasLaunched: false,
  cliOnboardingPromptSent: false,
  cliResumeAvailable: false,
  cli: undefined,
  cliModel: undefined,
  cliPermissionPreset: 'default',
  cliStartupPrompt: undefined,
  kind,
  specialistId: undefined,
  multiloopRole: undefined,
  backlogItemRef: undefined,
})

export const defaultEditorState = (): EditorState => ({
  openFiles: [],
  activeFilePath: null,
})

export function normalizeAgentCli(agent: Partial<AgentState>, fallback?: AgentCli): AgentCli | undefined {
  const cli = typeof agent.cli === 'string' ? agent.cli.trim() : ''
  if (cli) return cli
  const fallbackCli = typeof fallback === 'string' ? fallback.trim() : ''
  if (!fallbackCli) return undefined
  return fallbackCli
}

// A model id is only meaningful as free text the CLI will interpret; trim and
// drop empties so a cleared selection reads as "use the CLI default".
export function normalizeAgentCliModel(value: unknown): string | undefined {
  const model = typeof value === 'string' ? value.trim() : ''
  return model || undefined
}

export function normalizeAgentConversation(
  input: Partial<AgentConversationRuntime> | null | undefined,
): AgentConversationRuntime | undefined {
  const providerId = typeof input?.providerId === 'string' ? input.providerId.trim() : ''
  const modelId = typeof input?.modelId === 'string' ? input.modelId.trim() : ''
  if (!providerId || !modelId) return undefined
  return { providerId, modelId }
}

// Resolve the persisted runtime selection into a safe pair. Older persisted
// agents have no `runtimeKind` and stay terminal. A `conversation` kind only
// holds when a valid provider/model pair is present; a partial or corrupt
// selection falls back to terminal so an agent is never stranded in a chat
// runtime with no provider to talk to.
export function normalizeAgentRuntime(agent: Partial<AgentState>): {
  runtimeKind: AgentRuntimeKind
  conversation: AgentConversationRuntime | undefined
} {
  const conversation = normalizeAgentConversation(agent.conversation)
  if (agent.runtimeKind === 'conversation' && conversation) {
    return { runtimeKind: 'conversation', conversation }
  }
  return { runtimeKind: 'terminal', conversation: undefined }
}

export function normalizeAgentState(agent: AgentState, fallbackCli?: AgentCli): AgentState {
  const runtime = normalizeAgentRuntime(agent)
  return {
    ...agent,
    cli: normalizeAgentCli(agent, fallbackCli),
    cliModel: normalizeAgentCliModel(agent.cliModel),
    execution: normalizeAgentExecution(agent.execution),
    cliPermissionPreset: normalizeCliPermissionPreset(agent.cliPermissionPreset),
    runtimeKind: runtime.runtimeKind,
    conversation: runtime.conversation,
  }
}

export function pickWorkspaceAgentName(agents: Workspace['agents']): string {
  return pickRandomAgentName(Object.values(agents).map((agent) => agent.name))
}

export function isPathOrChild(path: string, parentPath: string): boolean {
  if (path === parentPath) return true
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return path.startsWith(`${parentPath}${separator}`)
}

export interface AgentsSliceState {}

export interface AgentsSliceActions {
  updateAgent: (workspaceId: WorkspaceId, agentId: AgentId, update: Partial<AgentState>) => void
  applyAgentTerminalSessionEvent: (apply: AgentTerminalSessionApply) => void
  applyAgentTerminalLaunchStateEvent: (apply: AgentTerminalLaunchStateApply) => void
  setAgentExecution: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    execution: Partial<AgentExecution>
  ) => void
  appendStream: (workspaceId: WorkspaceId, agentId: AgentId, chunk: string) => void
  commitStream: (workspaceId: WorkspaceId, agentId: AgentId) => void
  reconcileWorkspaceAgentLaunchFlags: (sessions: TerminalSessionSnapshot[]) => void
  openFile: (workspaceId: WorkspaceId, path: string, name: string, content: string) => void
  closeFile: (workspaceId: WorkspaceId, path: string) => void
  setActiveFile: (workspaceId: WorkspaceId, path: string) => void
  updateFileContent: (workspaceId: WorkspaceId, path: string, content: string) => void
  markFileClean: (workspaceId: WorkspaceId, path: string) => void
  remapOpenFiles: (workspaceId: WorkspaceId, fromPath: string, toPath: string) => void
  removeOpenFilesForPath: (workspaceId: WorkspaceId, path: string) => void
}

export type AgentsSlice = AgentsSliceState & AgentsSliceActions

type AgentsSliceCarrier = { workspaces: Workspace[] }
type AgentsSliceSet = (mutator: (state: AgentsSliceCarrier) => void) => void

export function createAgentsSlice(set: AgentsSliceSet): AgentsSlice {
  return {
    updateAgent: (workspaceId, agentId, update) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
        Object.assign(ws.agents[agentId], update)
        ws.agents[agentId].execution = normalizeAgentExecution(ws.agents[agentId].execution)
      }),

    applyAgentTerminalSessionEvent: ({ workspaceId, agentId, sessionId, cli }) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
        Object.assign(ws.agents[agentId], {
          cliSessionId: sessionId,
          cli,
          cliStartRequested: true,
          cliHasLaunched: true,
          cliResumeAvailable: agentCliSupportsConversationResume(cli),
        })
        ws.agents[agentId].execution = normalizeAgentExecution(ws.agents[agentId].execution)
      }),

    applyAgentTerminalLaunchStateEvent: ({
      workspaceId,
      agentId,
      cliSessionId,
      cliStartRequested,
      cliHasLaunched,
      cliOnboardingPromptSent,
      cliResumeAvailable,
    }) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        // Launch-state events only carry flags, never identity — applying one
        // to an agent that no longer exists must NOT materialize a default
        // record. (Completion teardown removes agents; the old upsert here
        // turned the teardown's own launch-state echo into a persistent ghost
        // agent that re-triggered teardown on every reopen.)
        const agent = ws.agents[agentId]
        if (!agent) return
        if (cliSessionId !== undefined) agent.cliSessionId = cliSessionId ?? undefined
        if (cliStartRequested !== undefined) agent.cliStartRequested = cliStartRequested
        if (cliHasLaunched !== undefined) agent.cliHasLaunched = cliHasLaunched
        if (cliOnboardingPromptSent !== undefined) agent.cliOnboardingPromptSent = cliOnboardingPromptSent
        if (cliResumeAvailable !== undefined) agent.cliResumeAvailable = cliResumeAvailable
        agent.execution = normalizeAgentExecution(agent.execution)
      }),

    setAgentExecution: (workspaceId, agentId, execution) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
        ws.agents[agentId].execution = normalizeAgentExecution({
          ...ws.agents[agentId].execution,
          ...execution,
        })
      }),

    appendStream: (workspaceId, agentId, chunk) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (!ws.agents[agentId]) ws.agents[agentId] = defaultAgent(agentId)
        ws.agents[agentId].streamBuffer += chunk
        ws.agents[agentId].status = 'streaming'
      }),

    commitStream: (workspaceId, agentId) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        const agent = ws?.agents[agentId]
        if (!agent) return

        if (agent.streamBuffer) {
          agent.messages.push({
            role: 'assistant',
            content: agent.streamBuffer,
            timestamp: Date.now(),
          })
          agent.streamBuffer = ''
        }

        if (agent.status !== 'error') {
          agent.status = 'complete'
        }
      }),

    reconcileWorkspaceAgentLaunchFlags: (sessions) =>
      set((state) => {
        for (const ws of state.workspaces) {
          for (const [agentId, agent] of Object.entries(ws.agents)) {
            const matchingLive = sessions.find(
              (session) =>
                session.processAlive
                && session.kind === 'agent'
                && session.workspaceId === ws.id
                && (
                  (agent.cliSessionId && session.sessionId === agent.cliSessionId)
                  || session.agentId === agentId
                )
            )
            if (matchingLive) {
              agent.cliStartRequested = true
              agent.cliHasLaunched = true
              agent.cliSessionId = matchingLive.sessionId
              // Capture the agent's own CLI/harness session id (resume token).
              // For Claude it equals the terminal key; for Codex etc. it is the
              // harness id learned from the hook. Don't clobber a known id with
              // an undefined snapshot (the hook may not have reported yet).
              if (matchingLive.cliSessionId) agent.harnessSessionId = matchingLive.cliSessionId
              agent.cliResumeAvailable = true
              if (matchingLive.cli) agent.cli = matchingLive.cli
              continue
            }
            if (
              !agent.cliStartRequested
              && !agent.cliHasLaunched
              && !agent.cliSessionId
            ) continue
            if (agent.kind === 'sprintengine') {
              // MC-1444 window-disposal retention: the auto-run executor
              // deliberately parks a resume token (cliSessionId +
              // cliResumeAvailable with launch flags cleared) on a worker
              // whose task awaits its verdict, so a late changes_requested
              // respawn can resume the conversation. That shape has no live
              // session BY DESIGN — wiping it here (mount-time reconcile,
              // second sync window) silently forfeits the rework context.
              // Leave it: the supervisor clears it once the task completes
              // (clearStaleRetainedResumeState), and cold app starts still
              // reset it via the persist partialize.
              if (
                agent.cliResumeAvailable
                && agent.cliSessionId
                && !agent.cliStartRequested
                && !agent.cliHasLaunched
              ) continue
              agent.cliStartRequested = false
              agent.cliHasLaunched = false
              agent.cliSessionId = undefined
              agent.harnessSessionId = undefined
              agent.cliOnboardingPromptSent = false
              agent.cliResumeAvailable = false
              continue
            }
            if (agent.cliHasLaunched && agentCliSupportsConversationResume(agent.cli)) {
              agent.cliStartRequested = true
              agent.cliResumeAvailable = true
              continue
            }
            agent.cliStartRequested = false
            agent.cliHasLaunched = false
            agent.cliSessionId = undefined
            agent.harnessSessionId = undefined
          }
        }
      }),

    openFile: (workspaceId, path, name, content) => {
      setEditorBuffer(workspaceId, path, content)
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (!ws.editorState) ws.editorState = defaultEditorState()
        const existing = ws.editorState.openFiles.find((f) => f.path === path)
        if (existing) {
          existing.isDirty = false
          existing.name = name
          existing.language = detectLanguage(name)
          delete existing.content
        } else {
          ws.editorState.openFiles.push({
            path,
            name,
            language: detectLanguage(name),
            isDirty: false,
          })
        }
        ws.editorState.activeFilePath = path
      })
    },

    closeFile: (workspaceId, path) => {
      deleteEditorBuffer(workspaceId, path)
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws?.editorState) return
        const idx = ws.editorState.openFiles.findIndex((f) => f.path === path)
        if (idx === -1) return
        ws.editorState.openFiles.splice(idx, 1)
        if (ws.editorState.activeFilePath === path) {
          ws.editorState.activeFilePath = ws.editorState.openFiles.at(-1)?.path ?? null
        }
      })
    },

    setActiveFile: (workspaceId, path) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (ws?.editorState) ws.editorState.activeFilePath = path
      }),

    updateFileContent: (workspaceId, path, content) => {
      setEditorBuffer(workspaceId, path, content)
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        const file = ws?.editorState?.openFiles.find((f) => f.path === path)
        if (!file || file.isDirty) return
        file.isDirty = true
      })
    },

    markFileClean: (workspaceId, path) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        const file = ws?.editorState?.openFiles.find((f) => f.path === path)
        if (file) file.isDirty = false
      }),

    remapOpenFiles: (workspaceId, fromPath, toPath) => {
      remapEditorBuffers(workspaceId, fromPath, toPath)
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        const openFiles = ws?.editorState?.openFiles
        if (!ws?.editorState || !openFiles?.length) return

        const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
        const fromPrefix = `${fromPath}${separator}`

        openFiles.forEach((file) => {
          if (file.path !== fromPath && !file.path.startsWith(fromPrefix)) return

          const suffix = file.path === fromPath ? '' : file.path.slice(fromPath.length)
          file.path = `${toPath}${suffix}`
          file.name = file.path.split(/[/\\]/).filter(Boolean).pop() ?? file.name
        })

        if (ws.editorState.activeFilePath === fromPath) {
          ws.editorState.activeFilePath = toPath
        } else if (ws.editorState.activeFilePath?.startsWith(fromPrefix)) {
          ws.editorState.activeFilePath = `${toPath}${ws.editorState.activeFilePath.slice(fromPath.length)}`
        }
      })
    },

    removeOpenFilesForPath: (workspaceId, path) => {
      removeEditorBuffersForPath(workspaceId, path)
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        const openFiles = ws?.editorState?.openFiles
        if (!ws?.editorState || !openFiles?.length) return

        const activeFileDeleted = ws.editorState.activeFilePath
          ? isPathOrChild(ws.editorState.activeFilePath, path)
          : false

        ws.editorState.openFiles = openFiles.filter((file) => !isPathOrChild(file.path, path))

        if (activeFileDeleted) {
          ws.editorState.activeFilePath = ws.editorState.openFiles.at(-1)?.path ?? null
        }
      })
    },
  }
}
