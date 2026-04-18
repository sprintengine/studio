import React, { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../store/settingsStore'
import type { AiProvider } from '../../store/settingsStore'

interface Props {
  onClose: () => void
}

const providers: { id: AiProvider; label: string; description: string }[] = [
  {
    id: 'claude-cli',
    label: 'Claude Code CLI',
    description: 'Uses your local `claude` CLI — no API key needed.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    description: 'Direct API calls with your own key.',
  },
]

export default function SettingsModal({ onClose }: Props) {
  const { apiKey, setApiKey, provider, setProvider } = useSettingsStore()
  const [draftKey, setDraftKey] = useState(apiKey)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (provider === 'anthropic') inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, provider])

  const handleSave = () => {
    if (provider === 'anthropic') setApiKey(draftKey.trim())
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-[480px] max-w-[95vw] shadow-2xl">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Settings</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Stored locally in your browser.</p>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 text-xl leading-none">×</button>
        </div>

        <div className="space-y-5">
          {/* Provider selection */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-2">AI Provider</label>
            <div className="flex flex-col gap-2">
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setProvider(p.id)}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded border text-left transition-colors ${
                    provider === p.id
                      ? 'border-indigo-500 bg-indigo-600/10 text-zinc-100'
                      : 'border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                    provider === p.id ? 'border-indigo-400 bg-indigo-400' : 'border-zinc-600'
                  }`} />
                  <div>
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">{p.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* API key — only for Anthropic */}
          {provider === 'anthropic' && (
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                Anthropic API Key
              </label>
              <input
                ref={inputRef}
                type="password"
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                placeholder="sk-ant-…"
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
              />
              <p className="text-xs text-zinc-600 mt-1.5">
                Get your key at console.anthropic.com
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-sm text-white transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
