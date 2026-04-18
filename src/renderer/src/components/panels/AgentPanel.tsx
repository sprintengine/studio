import React, { useRef, useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useSettingsStore } from '../../store/settingsStore'
import { runAgent, cancelAgent } from '../../services/agentRunner'
import { DEFAULT_AGENT_CONFIG } from '../../types/workspace'
import type { AgentStatus, SwarmRole } from '../../types/workspace'
import TerminalView from './TerminalView'

interface Props {
  workspaceId: string
  agentId: string
}

const statusBadge: Record<AgentStatus, string> = {
  idle:      'bg-zinc-800 text-zinc-500',
  running:   'bg-amber-900/50 text-amber-400',
  streaming: 'bg-emerald-900/50 text-emerald-400',
  error:     'bg-red-900/50 text-red-400',
  complete:  'bg-zinc-800 text-zinc-400',
}

const roleBadge: Record<SwarmRole, string> = {
  standalone:   'bg-zinc-800 text-zinc-500',
  worker:       'bg-sky-900/50 text-sky-300',
  reviewer:     'bg-amber-900/50 text-amber-300',
  orchestrator: 'bg-indigo-900/60 text-indigo-300',
}

export default function AgentPanel({ workspaceId, agentId }: Props) {
  const agent = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]
  )
  const swarmEnabled = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.swarmConfig.enabled ?? false
  )
  const role = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.swarmConfig.agents.find((a) => a.agentId === agentId)?.role ?? 'standalone'
  )
  const updateAgent  = useWorkspaceStore((s) => s.updateAgent)
  const appendStream = useWorkspaceStore((s) => s.appendStream)
  const commitStream = useWorkspaceStore((s) => s.commitStream)
  const apiKey       = useSettingsStore((s) => s.apiKey)
  const provider     = useSettingsStore((s) => s.provider)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)
  const noKeyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [noKey, setNoKey] = useState(false)

  const isActive = agent?.status === 'streaming' || agent?.status === 'running'

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [agent?.messages.length, agent?.streamBuffer])

  useEffect(() => {
    return () => {
      if (noKeyTimerRef.current) {
        clearTimeout(noKeyTimerRef.current)
      }
    }
  }, [])

  const handleSend = () => {
    const value = inputRef.current?.value.trim()
    if (!value || isActive) return

    if (provider === 'anthropic' && !apiKey) {
      if (noKeyTimerRef.current) {
        clearTimeout(noKeyTimerRef.current)
      }
      setNoKey(true)
      noKeyTimerRef.current = setTimeout(() => {
        setNoKey(false)
        noKeyTimerRef.current = null
      }, 3000)
      return
    }

    if (inputRef.current) inputRef.current.value = ''

    const currentMessages = agent?.messages ?? []
    updateAgent(workspaceId, agentId, {
      messages: [...currentMessages, { role: 'user', content: value, timestamp: Date.now() }],
      status: 'running',
    })

    const callbacks = {
      onChunk: (text: string) => appendStream(workspaceId, agentId, text),
      onDone:  ()             => commitStream(workspaceId, agentId),
      onError: (err: Error)   => updateAgent(workspaceId, agentId, {
        status: 'error',
        streamBuffer: '',
        messages: [
          ...currentMessages,
          { role: 'user',      content: value,              timestamp: Date.now() },
          { role: 'assistant', content: `Error: ${err.message}`, timestamp: Date.now() },
        ],
      }),
    }

    runAgent(agentId, apiKey, DEFAULT_AGENT_CONFIG, currentMessages, value, callbacks)
  }

  const handleStop = () => {
    cancelAgent(agentId)
    commitStream(workspaceId, agentId)
  }

  const status = agent?.status ?? 'idle'

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-200">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-zinc-400 font-mono truncate">{agentId}</span>
          {swarmEnabled && role !== 'standalone' && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono shrink-0 ${roleBadge[role]}`}>
              {role}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {provider === 'claude-cli' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-zinc-800 text-zinc-500">cli</span>
          )}
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${statusBadge[status]}`}>
            {status}
          </span>
        </div>
      </div>

      {provider === 'claude-cli' ? (
        <div className="flex-1 relative overflow-hidden">
          <TerminalView />
        </div>
      ) : (
        <>
          {/* Message feed */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 text-sm">
            {agent?.messages.map((msg, i) => (
              <div key={i} className={msg.role === 'user' ? 'text-zinc-400' : 'text-zinc-200'}>
                <span className="text-[10px] text-zinc-600 uppercase font-mono mr-2">{msg.role}</span>
                <span className="whitespace-pre-wrap">{msg.content}</span>
              </div>
            ))}

            {agent?.streamBuffer && (
              <div className="text-zinc-200">
                <span className="text-[10px] text-zinc-600 uppercase font-mono mr-2">assistant</span>
                <span className="whitespace-pre-wrap">{agent.streamBuffer}</span>
                <span className="inline-block w-[5px] h-[14px] bg-indigo-400 ml-0.5 align-middle animate-pulse" />
              </div>
            )}

            {!agent?.messages.length && !agent?.streamBuffer && (
              <p className="text-zinc-700 text-xs text-center pt-4">Agent ready</p>
            )}
          </div>

          {/* No-key warning — only for Anthropic provider */}
          {noKey && (
            <div className="mx-2 mb-1 px-3 py-1.5 bg-amber-900/30 border border-amber-700/50 rounded text-xs text-amber-400">
              No API key set — open Settings (⚙) to add your Anthropic key.
            </div>
          )}

          {/* Input row */}
          <div className="p-2 border-t border-zinc-800/80 shrink-0">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                disabled={isActive}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
                placeholder={isActive ? 'Streaming…' : 'Send a message…'}
              />
              {isActive ? (
                <button
                  onClick={handleStop}
                  className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-xs text-white transition-colors"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 rounded text-xs text-white transition-colors"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
