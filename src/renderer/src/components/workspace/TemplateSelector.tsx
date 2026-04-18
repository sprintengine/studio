import React, { useEffect, useState } from 'react'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import type { LayoutTemplate, PreviewSlot } from '../../types/workspace'

interface Props {
  onCreate: (args: { template: LayoutTemplate; name: string; folderPath: string | null }) => void
  onClose: () => void
  allowClose?: boolean
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export default function TemplateSelector({ onCreate, onClose, allowClose = true }: Props) {
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [selectedId, setSelectedId] = useState<string>(LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && allowClose) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, allowClose])

  const handlePick = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setFolderPath(dir)
    if (!nameTouched) setName(basename(dir) || 'workspace')
  }

  const selected = LAYOUT_TEMPLATES.find((t) => t.id === selectedId) ?? LAYOUT_TEMPLATES[0]

  const canCreate = name.trim().length > 0

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({ template: selected, name: name.trim(), folderPath })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#08080a]/95"
      onClick={(e) => allowClose && e.target === e.currentTarget && onClose()}
    >
      {/* subtle dot texture */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.018) 0, rgba(255,255,255,0.018) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      <div className="relative w-full max-w-[1100px] my-10 mx-5">
        <div className="overflow-hidden rounded-2xl border border-[#23262d] bg-[#0f1012] shadow-[0_28px_70px_rgba(0,0,0,0.55)]">
          {/* Top bar */}
          <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-[#23262d] bg-[#101114]">
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-zinc-500">Workspace</div>
              <h1 className="m-0 text-[22px] font-semibold tracking-tight text-zinc-100">
                New Workspace
              </h1>
            </div>
            {allowClose && (
              <button
                onClick={onClose}
                className="h-9 px-3 rounded-[10px] border border-[#23262d] bg-[#14161a] text-sm text-zinc-400 hover:text-zinc-200 hover:bg-[#1a1c20] transition-colors"
              >
                Cancel
              </button>
            )}
          </div>

          <div className="grid gap-5 p-6">
            {/* Folder + name */}
            <section className="rounded-2xl border border-[#23262d] bg-[#111214] p-5">
              <div className="grid gap-3" style={{ gridTemplateColumns: '1fr auto' }}>
                <div className="flex items-center gap-3 px-4 min-h-[52px] rounded-xl border border-[#23262d] bg-[#14161a]">
                  <div className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Folder
                    </span>
                    <span className="text-sm text-zinc-200 truncate font-mono">
                      {folderPath ?? 'No folder selected'}
                    </span>
                  </div>
                </div>
                <button
                  onClick={handlePick}
                  className="min-h-[52px] px-5 rounded-xl border border-[#2d3139] bg-[#1a1c20] text-sm font-medium text-zinc-200 hover:bg-[#1f2127] transition-colors"
                >
                  Choose Folder
                </button>
              </div>

              <div className="mt-3 flex items-center gap-3 px-4 min-h-[52px] rounded-xl border border-[#23262d] bg-[#14161a]">
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Workspace Name
                  </span>
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setNameTouched(true)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                    placeholder="my-workspace"
                    className="bg-transparent border-0 outline-none text-sm text-zinc-100 placeholder-zinc-600 font-mono"
                  />
                </div>
              </div>
            </section>

            {/* Templates */}
            <section className="rounded-2xl border border-[#23262d] bg-[#111214] p-5">
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="m-0 text-[15px] font-semibold tracking-tight text-zinc-200">Template</h2>
                <span className="text-xs text-zinc-500">{selected.description}</span>
              </div>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-3">
                {LAYOUT_TEMPLATES.map((t) => {
                  const isSelected = t.id === selectedId
                  return (
                    <button
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className={`group text-left flex flex-col gap-3 p-3 rounded-2xl border transition-all focus:outline-none ${
                        isSelected
                          ? 'border-[#5d616c] bg-[#1a1c20]'
                          : 'border-[#23262d] bg-[#14161a] hover:border-[#2d3139] hover:bg-[#17191d] hover:-translate-y-px'
                      }`}
                    >
                      <div className="rounded-xl overflow-hidden border border-[#1f2229] bg-[#0c0d10]">
                        <LayoutPreview slots={t.previewSlots} />
                      </div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[15px] font-semibold tracking-tight text-zinc-100 truncate">
                            {t.name}
                          </div>
                          <div className="text-xs text-zinc-500 mt-0.5 truncate">{t.description}</div>
                        </div>
                        <span
                          className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] px-2 py-1 rounded-full ${
                            isSelected ? 'bg-[#343740] text-zinc-100' : 'bg-[#23252b] text-zinc-500'
                          }`}
                        >
                          {agentCountLabel(t.previewSlots)}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-4 px-6 py-5 border-t border-[#23262d] bg-[#0f1012]">
            <div className="text-xs text-zinc-500">
              Workspace opens in a new tab with its own layout and agents.
            </div>
            <div className="flex gap-2">
              {allowClose && (
                <button
                  onClick={onClose}
                  className="h-11 px-4 rounded-xl border border-[#23262d] bg-[#14161a] text-sm font-medium text-zinc-200 hover:bg-[#1a1c20] transition-colors"
                >
                  Back
                </button>
              )}
              <button
                onClick={handleCreate}
                disabled={!canCreate}
                className="h-11 px-5 rounded-xl border border-[#4d4d51] bg-zinc-200 text-sm font-semibold text-zinc-950 hover:bg-white disabled:opacity-40 disabled:hover:bg-zinc-200 transition-colors"
              >
                Create Workspace
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function agentCountLabel(slots: PreviewSlot[]): string {
  const n = slots.filter((s) => s.type === 'agent').length
  return n === 1 ? '1 agent' : `${n} agents`
}

function LayoutPreview({ slots }: { slots: PreviewSlot[] }) {
  const style: Record<PreviewSlot['type'], { fill: string; stroke: string; text: string; glow: string }> = {
    // files = yellow
    explorer: {
      fill: 'url(#grad-files)',
      stroke: 'rgba(255, 206, 107, 0.40)',
      text: '#f3d69e',
      glow: 'rgba(255, 198, 84, 0.18)',
    },
    // editor = green
    editor: {
      fill: 'url(#grad-editor)',
      stroke: 'rgba(111, 219, 145, 0.38)',
      text: '#b8f2c8',
      glow: 'rgba(72, 181, 106, 0.18)',
    },
    // agent = blue
    agent: {
      fill: 'url(#grad-agent)',
      stroke: 'rgba(85, 147, 255, 0.42)',
      text: '#a9c8ff',
      glow: 'rgba(57, 118, 255, 0.20)',
    },
  }

  return (
    <svg viewBox="0 0 300 110" className="block w-full h-[110px]" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad-agent" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(15,30,48,0.98)" />
          <stop offset="100%" stopColor="rgba(12,22,34,0.98)" />
        </linearGradient>
        <linearGradient id="grad-editor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(20,32,24,0.98)" />
          <stop offset="100%" stopColor="rgba(15,23,18,0.98)" />
        </linearGradient>
        <linearGradient id="grad-files" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(42,33,14,0.98)" />
          <stop offset="100%" stopColor="rgba(31,25,12,0.98)" />
        </linearGradient>
        <pattern id="dots" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="rgba(255,255,255,0.04)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="300" height="110" fill="#0c0d10" />
      <rect x="0" y="0" width="300" height="110" fill="url(#dots)" />
      {slots.map((slot, i) => {
        const c = style[slot.type]
        return (
          <g key={i}>
            <rect
              x={slot.x}
              y={slot.y}
              width={slot.w}
              height={slot.h}
              rx="6"
              fill={c.fill}
              stroke={c.stroke}
              strokeWidth="0.8"
              style={{ filter: `drop-shadow(0 0 6px ${c.glow})` }}
            />
            <text
              x={slot.x + slot.w / 2}
              y={slot.y + slot.h / 2 + 3}
              textAnchor="middle"
              fontSize={slot.w < 70 ? '7' : '8'}
              fontWeight="700"
              letterSpacing="0.08em"
              fill={c.text}
              fontFamily="ui-monospace, monospace"
            >
              {slot.label.toUpperCase()}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
