import React, { useEffect } from 'react'

interface Props {
  onClose: () => void
}

export default function SettingsModal({ onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="w-[440px] max-w-[95vw] rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Settings</h2>
            <p className="mt-0.5 text-sm text-zinc-500">Multicode uses Claude CLI automatically.</p>
          </div>
          <button onClick={onClose} className="text-xl leading-none text-zinc-600 hover:text-zinc-300">
            ×
          </button>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 text-sm leading-6 text-zinc-300">
          <p>No configurable app settings are exposed yet.</p>
          <p className="mt-2 text-zinc-500">
            The old provider and Anthropic API key options were removed. Claude CLI is now the only runtime path.
          </p>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded bg-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
