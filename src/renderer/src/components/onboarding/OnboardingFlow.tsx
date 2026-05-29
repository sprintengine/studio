import { useEffect, useId, useRef } from 'react'

import MulticodeWordmark from '../brand/MulticodeWordmark'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { PrimaryButton } from '../ui'
import { ModuleProfilePicker, ModuleToggleList } from '../settings/ModuleControls'

// First-run onboarding (Phase 9). A guided, branded sequence for a fresh install:
//   welcome → modules (choose plugins) → workspace (NewWorkspacePanel)
// This component owns the welcome + modules steps as a centered overlay; the
// workspace step is the existing NewWorkspacePanel, revealed by WorkspaceManager
// once the step advances. There is nothing usable behind it on a fresh install,
// so the only way forward is the primary button — no Escape/backdrop dismiss.
//
// Built to knowledge/brand: ink-scale surface, one accent (the primary CTA),
// hairlines (no cards), sentence-case copy, the brand wordmark on welcome.
export default function OnboardingFlow() {
  const step = useWorkspaceStore((s) => s.appSettings.onboardingStep)
  const advanceOnboarding = useWorkspaceStore((s) => s.advanceOnboarding)
  const overrides = useWorkspaceStore((s) => s.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((s) => s.setModuleEnabled)
  const applyModuleProfile = useWorkspaceStore((s) => s.applyModuleProfile)

  const titleId = useId()
  const surfaceRef = useRef<HTMLDivElement>(null)

  // This component only renders the welcome + modules steps.
  const visible = step === 'welcome' || step === 'modules'

  useEffect(() => {
    if (!visible) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => surfaceRef.current?.focus())
    return () => {
      document.body.style.overflow = previous
      window.cancelAnimationFrame(frame)
    }
  }, [visible, step])

  if (!visible) return null

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
        {step === 'welcome' ? (
          <WelcomeStep titleId={titleId} onContinue={advanceOnboarding} />
        ) : (
          <ModulesStep
            titleId={titleId}
            overrides={overrides}
            onApply={applyModuleProfile}
            onToggle={setModuleEnabled}
            onContinue={advanceOnboarding}
          />
        )}
      </div>
    </div>
  )
}

function WelcomeStep({ titleId, onContinue }: { titleId: string; onContinue: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-14 text-center">
      <MulticodeWordmark className="h-7" />
      <div className="space-y-1.5">
        <h2 id={titleId} className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          Welcome to Multicode
        </h2>
        <p className="mx-auto max-w-[400px] text-[12px] leading-5 text-[color:var(--text-muted)]">
          A command surface for running coding agents. Pick the tools you want, then open your first
          workspace. Everything is configurable later in Settings.
        </p>
      </div>
      <PrimaryButton size="md" onClick={onContinue}>
        Get started
      </PrimaryButton>
    </div>
  )
}

function ModulesStep({
  titleId,
  overrides,
  onApply,
  onToggle,
  onContinue,
}: {
  titleId: string
  overrides: Parameters<typeof ModuleToggleList>[0]['overrides']
  onApply: Parameters<typeof ModuleProfilePicker>[0]['onApply']
  onToggle: Parameters<typeof ModuleToggleList>[0]['onToggle']
  onContinue: () => void
}) {
  return (
    <>
      <div className="border-b border-[color:var(--border-subtle)] px-6 py-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          Choose your tools
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
          Pick a starting profile, or switch individual capabilities on and off. You can change this
          later in Settings.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-2 text-[11px] font-medium text-[color:var(--text-subtle)]">Profiles</div>
        <ModuleProfilePicker overrides={overrides} onApply={onApply} />
        <div className="mt-5">
          <ModuleToggleList overrides={overrides} onToggle={onToggle} />
        </div>
      </div>

      <div className="flex justify-end border-t border-[color:var(--border-subtle)] px-6 py-4">
        <PrimaryButton size="md" onClick={onContinue}>
          Continue
        </PrimaryButton>
      </div>
    </>
  )
}
