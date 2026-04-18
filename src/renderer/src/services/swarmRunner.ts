import { runAgent, cancelAgent } from './agentRunner'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useSettingsStore } from '../store/settingsStore'
import { DEFAULT_AGENT_CONFIG } from '../types/workspace'
import type { AgentConfig, SwarmConfig } from '../types/workspace'

// Route a user message through the swarm.
// If there's an orchestrator, it runs first; its response is forwarded to workers.
// Workers run concurrently.
export async function runSwarm(
  workspaceId: string,
  swarm: SwarmConfig,
  userMessage: string
): Promise<void> {
  const apiKey = useSettingsStore.getState().apiKey
  if (!apiKey) return

  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((w) => w.id === workspaceId)
  if (!workspace) return

  const { orchestratorId, agents } = swarm
  const activeAgents = agents.filter((a) => a.role !== 'standalone')
  if (activeAgents.length === 0) return

  if (!orchestratorId) {
    // No orchestrator: run all non-standalone agents in parallel with the same message
    await Promise.all(
      activeAgents.map(({ agentId, config }) =>
        _runOne(workspaceId, agentId, apiKey, config ?? DEFAULT_AGENT_CONFIG, userMessage)
      )
    )
    return
  }

  // Step 1: run orchestrator
  const orchestratorAgent = activeAgents.find((a) => a.agentId === orchestratorId)
  if (!orchestratorAgent) return

  let orchestratorResponse = ''
  await _runOne(
    workspaceId,
    orchestratorId,
    apiKey,
    orchestratorAgent.config ?? DEFAULT_AGENT_CONFIG,
    userMessage,
    (chunk) => { orchestratorResponse += chunk }
  )

  // Step 2: fan out to workers concurrently with the orchestrator's response as their task
  const workers = activeAgents.filter((a) => a.agentId !== orchestratorId)
  await Promise.all(
    workers.map(({ agentId, config }) =>
      _runOne(
        workspaceId,
        agentId,
        apiKey,
        config ?? DEFAULT_AGENT_CONFIG,
        `Orchestrator task:\n${orchestratorResponse}\n\nUser original request:\n${userMessage}`
      )
    )
  )
}

async function _runOne(
  workspaceId: string,
  agentId: string,
  apiKey: string,
  config: AgentConfig,
  message: string,
  onChunkExtra?: (chunk: string) => void
): Promise<void> {
  const store = useWorkspaceStore.getState()
  const ws = store.workspaces.find((w) => w.id === workspaceId)
  const history = ws?.agents[agentId]?.messages ?? []

  store.updateAgent(workspaceId, agentId, {
    messages: [...history, { role: 'user', content: message, timestamp: Date.now() }],
    status: 'running',
  })

  return new Promise((resolve) => {
    runAgent(agentId, apiKey, config, history, message, {
      onChunk: (chunk) => {
        store.appendStream(workspaceId, agentId, chunk)
        onChunkExtra?.(chunk)
      },
      onDone: () => {
        store.commitStream(workspaceId, agentId)
        resolve()
      },
      onError: (err) => {
        store.updateAgent(workspaceId, agentId, { status: 'error', streamBuffer: '' })
        console.error(`[swarm] agent ${agentId} error:`, err)
        resolve()
      },
    })
  })
}

export function cancelSwarm(swarm: SwarmConfig): void {
  swarm.agents.forEach(({ agentId }) => cancelAgent(agentId))
}
