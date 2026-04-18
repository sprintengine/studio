import React, { useEffect } from 'react'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import type { LayoutTemplate, PreviewSlot } from '../../types/workspace'

interface Props {
  onSelect: (template: LayoutTemplate) => void
  onClose: () => void
}

export default function TemplateSelector({ onSelect, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-[740px] max-w-[95vw] shadow-2xl">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">New Workspace</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Choose a layout for your agent swarm</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-zinc-300 text-xl leading-none transition-colors"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {LAYOUT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              onClick={() => onSelect(template)}
              className="group text-left p-4 rounded-lg border border-zinc-700/80 hover:border-indigo-500 bg-zinc-950/40 hover:bg-zinc-800/50 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <div className="h-[90px] mb-3 rounded-md overflow-hidden border border-zinc-800 bg-zinc-950">
                <LayoutPreview slots={template.previewSlots} />
              </div>
              <div className="text-sm font-medium text-zinc-300 group-hover:text-white transition-colors">
                {template.name}
              </div>
              <div className="text-xs text-zinc-600 mt-0.5 leading-relaxed">{template.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function LayoutPreview({ slots }: { slots: PreviewSlot[] }) {
  const slotColor: Record<PreviewSlot['type'], { fill: string; stroke: string; text: string }> = {
    agent:    { fill: '#1e1b4b', stroke: '#4f46e5', text: '#a5b4fc' },
    editor:   { fill: '#18181b', stroke: '#3f3f46', text: '#71717a' },
    explorer: { fill: '#1c1c20', stroke: '#3f3f46', text: '#71717a' },
  }

  return (
    <svg viewBox="0 0 300 90" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      {slots.map((slot, i) => {
        const c = slotColor[slot.type]
        return (
          <g key={i}>
            <rect x={slot.x} y={slot.y} width={slot.w} height={slot.h} rx="3" fill={c.fill} stroke={c.stroke} strokeWidth="0.8" />
            <text
              x={slot.x + slot.w / 2}
              y={slot.y + slot.h / 2 + 3}
              textAnchor="middle"
              fontSize="7"
              fill={c.text}
              fontFamily="ui-monospace, monospace"
            >
              {slot.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
