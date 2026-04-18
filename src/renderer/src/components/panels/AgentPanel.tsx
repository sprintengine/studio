import React, { useRef, useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useSettingsStore } from '../../store/settingsStore'
import { runAgent, cancelAgent } from '../../services/agentRunner'
import { DEFAULT_AGENT_CONFIG } from '../../types/workspace'
import type { AgentStatus } from '../../types/workspace'
import TerminalView from './TerminalView'

interface Props {
  workspaceId: string
  agentId: string
}

const statusDot: Record<AgentStatus, string> = {
  idle:      'bg-zinc-600',
  running:   'bg-amber-400 animate-pulse',
  streaming: 'bg-emerald-400 animate-pulse',
  error:     'bg-red-500',
  complete:  'bg-zinc-500',
}

const statusLabel: Record<AgentStatus, string> = {
  idle:      'ready',
  running:   'running',
  streaming: 'streaming',
  error:     'error',
  complete:  'idle',
}

export default function AgentPanel({ workspaceId, agentId }: Props) {
  const agent = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]
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
      if (noKeyTimerRef.current) clearTimeout(noKeyTimerRef.current)
    }
  }, [])

  const handleSend = () => {
    const value = inputRef.current?.value.trim()
    if (!value || isActive) return

    if (provider === 'anthropic' && !apiKey) {
      if (noKeyTimerRef.current) clearTimeout(noKeyTimerRef.current)
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

    runAgent(agentId, apiKey, DEFAULT_AGENT_CONFIG, currentMessages, value, {
      onChunk: (text) => appendStream(workspaceId, agentId, text),
      onDone:  ()     => commitStream(workspaceId, agentId),
      onError: (err)  => updateAgent(workspaceId, agentId, {
        status: 'error',
        streamBuffer: '',
        messages: [
          ...currentMessages,
          { role: 'user',      content: value,                timestamp: Date.now() },
          { role: 'assistant', content: `Error: ${err.message}`, timestamp: Date.now() },
        ],
      }),
    })
  }

  const handleStop = () => {
    cancelAgent(agentId)
    commitStream(workspaceId, agentId)
  }

  const status = agent?.status ?? 'idle'

  return (
    <div className="flex flex-col h-full bg-[#15171b] text-zinc-200 font-mono text-[12px]">
      {/* Compact header */}
      <div className="flex items-center justify-between gap-3 px-3 h-9 border-b border-[#23262d] bg-[#17191d] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[status]}`} />
          <span className="text-[12px] text-zinc-200 truncate">{agentId}</span>
          <span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 shrink-0">
            {statusLabel[status]}
          </span>
        </div>
        {provider === 'claude-cli' && (
          <span className="text-[10px] uppercase tracking-[0.08em] text-zinc-500 shrink-0">cli</span>
        )}
      </div>

      {provider === 'claude-cli' ? (
        <div className="flex-1 relative overflow-hidden bg-[#0b0c0e]">
          <TerminalView />
        </div>
      ) : (
        <>
          {/* Terminal feed */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3.5 py-3 leading-[1.7] text-[12px] text-zinc-300 whitespace-pre-wrap"
            style={{
              backgroundImage:
                'radial-gradient(circle, rgba(255,255,255,0.022) 0, rgba(255,255,255,0.022) 1px, transparent 1px)',
              backgroundSize: '18px 18px',
            }}
          >
            {!agent?.messages.length && !agent?.streamBuffer && (
              <div className="text-zinc-600 select-none">
                <span className="text-emerald-500/80">$</span> codex task "describe your task"
                <br />
                <span className="text-zinc-700">[{agentId}] ready — send a command below</span>
              </div>
            )}

            {agent?.messages.map((msg, i) =>
              msg.role === 'user' ? (
                <div key={i} className="text-zinc-200">
                  <span className="text-emerald-500/80">$</span> {msg.content}
                </div>
              ) : (
                <div key={i} className="text-zinc-300">
                  <span className="text-[#6c97d9]">[{agentId}]</span> {msg.content}
                </div>
              )
            )}

            {agent?.streamBuffer && (
              <div className="text-zinc-200">
                <span className="text-[#6c97d9]">[{agentId}]</span> {agent.streamBuffer}
                <span className="inline-block w-[7px] h-[13px] bg-emerald-400 ml-0.5 align-middle animate-pulse" />
              </div>
            )}
          </div>

          {noKey && (
            <div className="mx-2 mb-1 px-3 py-1.5 rounded-md bg-amber-900/30 border border-amber-700/50 text-[11px] text-amber-400">
              No API key set — open Settings to add your Anthropic key.
            </div>
          )}

          {/* Input row */}
          <div className="flex items-center gap-2 px-2.5 py-2 border-t border-[#23262d] bg-[#17191d] shrink-0">
            <span className="text-emerald-500/80 text-[12px] pl-1 select-none">$</span>
            <input
              ref={inputRef}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              disabled={isActive}
              className="flex-1 h-8 bg-[#121316] border border-[#23262d] rounded-[8px] px-3 text-[12px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-[#3d4252] font-mono disabled:opacity-50"
              placeholder={isActive ? 'streaming…' : `send to ${agentId}`}
            />
            {isActive ? (
              <button
                onClick={handleStop}
                className="h-8 px-3 rounded-[8px] bg-red-700/90 hover:bg-red-600 text-[11px] font-medium text-white transition-colors"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                className="h-8 px-3 rounded-[8px] border border-[#4d4d51] bg-zinc-200 text-[11px] font-semibold text-zinc-950 hover:bg-white transition-colors"
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
