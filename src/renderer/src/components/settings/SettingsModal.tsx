import React, { useEffect } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'

interface Props {
  onClose: () => void
}

export default function SettingsModal({ onClose }: Props) {
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const isWindows = window.api.platform === 'win32'

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
      <div className="w-[560px] max-w-[95vw] rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Settings</h2>
            <p className="mt-0.5 text-sm text-zinc-500">Configure the CLIs ALIENCODE should launch.</p>
          </div>
          <button onClick={onClose} className="text-xl leading-none text-zinc-600 hover:text-zinc-300">
            x
          </button>
        </div>

        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
          {([
            ['codex', 'Codex command'],
            ['claude', 'Claude command'],
          ] as Array<[AgentCli, string]>).map(([cli, label]) => (
            <div key={cli} className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  {label}
                </span>
                <input
                  value={cliRuntimes[cli].command}
                  onChange={(event) => setCliRuntime(cli, { command: event.target.value })}
                  placeholder={cli}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition-colors focus:border-[#6ee7d8]/70"
                />
              </label>

              {isWindows && (
                <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  <span className="text-sm text-zinc-300">
                    Run {cli === 'codex' ? 'Codex' : 'Claude'} through WSL
                  </span>
                  <input
                    type="checkbox"
                    checked={cliRuntimes[cli].useWsl}
                    onChange={(event) => setCliRuntime(cli, { useWsl: event.target.checked })}
                    className="peer sr-only"
                  />
                  <span className="relative h-5 w-9 rounded-full bg-zinc-700 transition-colors peer-checked:bg-[#6ee7d8] peer-checked:[&>span]:translate-x-4 peer-checked:[&>span]:bg-zinc-950">
                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-zinc-200 transition-transform" />
                  </span>
                </label>
              )}
            </div>
          ))}
          <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-[12px] leading-5 text-zinc-500">
            Defaults are <span className="font-mono text-zinc-300">codex</span> native and{' '}
            <span className="font-mono text-zinc-300">claude</span>{isWindows ? ' through WSL' : ''}.
            Use a full executable path if your CLI is not on PATH.
          </div>
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
