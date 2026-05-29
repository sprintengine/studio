import { useEffect, useId, useRef } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { PrimaryButton } from '../ui'
import { ModuleProfilePicker, ModuleToggleList } from './ModuleControls'

// First-run capability chooser. Shown once (until appSettings.modulesChosen),
// before the user settles into a workspace, so a fresh install starts with the
// tools they want rather than everything. Reuses the same profile picker and
// toggle list as Settings → Modules. There is nothing behind it on a fresh
// install, so the only way forward is Continue — no Escape/backdrop dismiss.
export default function ModuleChooserOverlay() {
  const overrides = useWorkspaceStore((s) => s.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((s) => s.setModuleEnabled)
  const applyModuleProfile = useWorkspaceStore((s) => s.applyModuleProfile)
  const setModulesChosen = useWorkspaceStore((s) => s.setModulesChosen)

  const titleId = useId()
  const surfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => surfaceRef.current?.focus())
    return () => {
      document.body.style.overflow = previous
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--surface-overlay-backdrop)] p-4 sm:p-8"
    >
      <div
        ref={surfaceRef}
        tabIndex={-1}
        className="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)] outline-none"
      >
        <div className="border-b border-[color:var(--border-subtle)] px-6 py-5">
          <h2 id={titleId} className="text-[15px] font-semibold text-[color:var(--text-strong)]">
            Choose your tools
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
            Pick a starting profile, or switch individual capabilities on and off. You can change
            this later in Settings.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mb-2 text-[11px] font-medium text-[color:var(--text-subtle)]">Profiles</div>
          <ModuleProfilePicker overrides={overrides} onApply={applyModuleProfile} />
          <div className="mt-5">
            <ModuleToggleList overrides={overrides} onToggle={setModuleEnabled} />
          </div>
        </div>

        <div className="flex justify-end border-t border-[color:var(--border-subtle)] px-6 py-4">
          <PrimaryButton size="md" onClick={() => setModulesChosen(true)}>
            Continue
          </PrimaryButton>
        </div>
      </div>
    </div>
  )
}
