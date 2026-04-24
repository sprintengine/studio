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
      <div className="w-[560px] max-w-[95vw] rounded-xl border border-[#303139] bg-[#0d0e11] p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-[#ececee]">Settings</h2>
            <p className="mt-0.5 text-sm text-[#5a5a63]">Configure the CLIs Multicode should launch.</p>
          </div>
          <button onClick={onClose} className="text-xl leading-none text-[#5a5a63] hover:text-[#d7d7dc]">
            x
          </button>
        </div>

        <div className="space-y-4 rounded-lg border border-[#24252b] bg-[#111216] p-4">
          {([
            ['codex', 'Codex command'],
            ['claude', 'Claude command'],
          ] as Array<[AgentCli, string]>).map(([cli, label]) => (
            <div key={cli} className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                  {label}
                </span>
                <input
                  value={cliRuntimes[cli].command}
                  onChange={(event) => setCliRuntime(cli, { command: event.target.value })}
                  placeholder={cli}
                  className="w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#6ee7d8]/70"
                />
              </label>

              {isWindows && (
                <label className="flex items-center justify-between rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2">
                  <span className="text-sm text-[#d7d7dc]">
                    Run {cli === 'codex' ? 'Codex' : 'Claude'} through WSL
                  </span>
                  <input
                    type="checkbox"
                    checked={cliRuntimes[cli].useWsl}
                    onChange={(event) => setCliRuntime(cli, { useWsl: event.target.checked })}
                    className="peer sr-only"
                  />
                  <span className="relative h-5 w-9 rounded-full bg-[#303139] transition-colors peer-checked:bg-[#6ee7d8] peer-checked:[&>span]:translate-x-4 peer-checked:[&>span]:bg-[#061210]">
                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#d7d7dc] transition-transform" />
                  </span>
                </label>
              )}
            </div>
          ))}
          <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2 text-[12px] leading-5 text-[#5a5a63]">
            Defaults are <span className="font-mono text-[#d7d7dc]">codex</span> native and{' '}
            <span className="font-mono text-[#d7d7dc]">claude</span>{isWindows ? ' through WSL' : ''}.
            Use a full executable path if your CLI is not on PATH.
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded border border-[#303139] bg-[#111216] px-4 py-1.5 text-sm font-medium text-[#ececee] transition-colors hover:bg-[#17181d]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
