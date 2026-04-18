import React, { useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useSettingsStore } from '../../store/settingsStore'
import { runSwarm, cancelSwarm } from '../../services/swarmRunner'
import type { SwarmRole } from '../../types/workspace'

interface Props {
  workspaceId: string
}

const ROLE_CYCLE: SwarmRole[] = ['standalone', 'worker', 'reviewer', 'orchestrator']

const roleBadge: Record<SwarmRole, string> = {
  standalone:   'bg-zinc-800 text-zinc-500',
  worker:       'bg-sky-900/50 text-sky-300',
  reviewer:     'bg-amber-900/50 text-amber-300',
  orchestrator: 'bg-indigo-900/60 text-indigo-300',
}

export default function SwarmBar({ workspaceId }: Props) {
  const swarm       = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.swarmConfig)
  const updateSwarm = useWorkspaceStore((s) => s.updateSwarm)
  const apiKey      = useSettingsStore((s) => s.apiKey)
  const [message, setMessage]   = useState('')
  const [running, setRunning]   = useState(false)

  if (!swarm) return null

  const cycleRole = (agentId: string) => {
    const current = swarm.agents.find((a) => a.agentId === agentId)?.role ?? 'standalone'
    const nextRole = ROLE_CYCLE[(ROLE_CYCLE.indexOf(current) + 1) % ROLE_CYCLE.length]
    const newAgents = swarm.agents.map((a) => {
      if (a.agentId === agentId) return { ...a, role: nextRole }
      // Only one orchestrator at a time — demote the previous to worker
      if (nextRole === 'orchestrator' && a.role === 'orchestrator') {
        return { ...a, role: 'worker' as SwarmRole }
      }
      return a
    })
    updateSwarm(workspaceId, { agents: newAgents })
  }

  const toggleEnabled = () => updateSwarm(workspaceId, { enabled: !swarm.enabled })

  const handleRun = async () => {
    const trimmed = message.trim()
    if (!trimmed || !apiKey || running) return
    setRunning(true)
    setMessage('')
    try {
      await runSwarm(workspaceId, swarm, trimmed)
    } finally {
      setRunning(false)
    }
  }

  const handleCancel = () => {
    cancelSwarm(swarm)
    setRunning(false)
  }

  const activeCount = swarm.agents.filter((a) => a.role !== 'standalone').length

  return (
    <div className="flex items-center gap-2 px-2 h-9 bg-zinc-900 border-b border-zinc-800 shrink-0 overflow-x-auto text-xs">
      <button
        onClick={toggleEnabled}
        className={`px-2 py-1 rounded font-mono shrink-0 transition-colors ${
          swarm.enabled
            ? 'bg-indigo-600 text-white hover:bg-indigo-500'
            : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
        }`}
        title="Toggle swarm mode"
      >
        ⟳ Swarm {swarm.enabled ? 'ON' : 'OFF'}
      </button>

      {swarm.enabled && (
        <>
          <div className="flex items-center gap-1 shrink-0">
            {swarm.agents.length === 0 ? (
              <span className="text-zinc-600 text-[10px] font-mono px-2">No agents in layout</span>
            ) : (
              swarm.agents.map((a) => (
                <button
                  key={a.agentId}
                  onClick={() => cycleRole(a.agentId)}
                  className={`px-2 py-0.5 rounded-full font-mono text-[10px] transition-colors ${roleBadge[a.role]}`}
                  title={`${a.agentId} — click to change role`}
                >
                  {a.agentId}:{a.role}
                </button>
              ))
            )}
          </div>

          <div className="flex-1 min-w-[200px] flex items-center gap-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleRun()}
              disabled={running || !apiKey || activeCount === 0}
              placeholder={
                !apiKey
                  ? 'No API key — open Settings (⚙)'
                  : activeCount === 0
                  ? 'Assign a role to at least one agent'
                  : running
                  ? 'Swarm running…'
                  : 'Broadcast to swarm…'
              }
              className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-3 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
            />
            {running ? (
              <button
                onClick={handleCancel}
                className="px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-xs text-white transition-colors shrink-0"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={handleRun}
                disabled={!message.trim() || !apiKey || activeCount === 0}
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 rounded text-xs text-white transition-colors shrink-0 disabled:opacity-40 disabled:hover:bg-indigo-600"
              >
                Run
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
