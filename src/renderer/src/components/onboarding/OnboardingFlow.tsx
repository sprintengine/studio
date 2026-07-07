import { useCallback, useEffect, useId, useMemo, useRef } from 'react'

import MulticodeWordmark from '../brand/MulticodeWordmark'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { GhostButton, PrimaryButton } from '../ui'
import { ModuleToggleList } from '../settings/ModuleControls'
import { CliInstallControl } from '../settings/CliInstallControl'
import { AppThemePicker } from '../settings/AppThemePicker'
import { cliRuntimeForPlugin, orderInstalledPlugins } from '../workspace/newWorkspace/cliRuntimeOptions'
import { AdoptConfigCard } from './AdoptConfigCard'
import { ExtensionsTeaser } from './ExtensionsTeaser'
import { FirstRunPayoff } from './FirstRunPayoff'

// Same focusable set the canonical Drawer focus trap uses, minus the sentinels.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// First-run onboarding (Phase 9). A guided, branded sequence for a fresh install:
//   welcome → theme → essentials → modules → workspace → first-run → complete
// This component owns the overlay steps (welcome, theme, essentials, modules,
// first-run) as a centered dialog; the workspace step is the existing
// NewWorkspacePanel, revealed by WorkspaceManager once the step advances. The
// first-run step renders AFTER workspace creation as the activation payoff. There
// is nothing usable behind the overlay on a fresh install, so the only way
// forward is the primary button — no Escape/backdrop dismiss.
//
// Built to knowledge/brand: ink-scale surface, one accent (the primary CTA),
// hairlines (no cards), sentence-case copy, the brand wordmark on welcome.
// The first-run activation payoff (T6) needs real app actions that live in
// WorkspaceManager — launching a real agent run and opening the real command
// palette — so WorkspaceManager supplies them here. Kept as props (not store
// reads) so OnboardingFlow never reaches into WorkspaceManager-local state.
export default function OnboardingFlow({
  hasConfiguredCli,
  onLaunchFirstAgent,
  onOpenCommandPalette,
}: {
  hasConfiguredCli: boolean
  onLaunchFirstAgent: () => void
  onOpenCommandPalette: () => void
}) {
  const step = useWorkspaceStore((s) => s.appSettings.onboardingStep)
  const advanceOnboarding = useWorkspaceStore((s) => s.advanceOnboarding)
  const overrides = useWorkspaceStore((s) => s.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((s) => s.setModuleEnabled)
  // The essentials-step extensions teaser (T4) opens the real Settings →
  // Extensions Browse surface. Both overlays share z-50 and this one renders
  // last (on top), so step aside while Settings is open and return to the same
  // step when it closes — onboarding progress is untouched.
  const settingsOpen = useWorkspaceStore((s) => s.settingsOverlay.open)

  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  // This component renders every onboarding step as an overlay EXCEPT workspace,
  // which is the existing NewWorkspacePanel revealed by WorkspaceManager.
  const visible =
    !settingsOpen &&
    (step === 'welcome' ||
      step === 'theme' ||
      step === 'essentials' ||
      step === 'modules' ||
      step === 'first-run')

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

  // Runtime focus recovery (WCAG 2.4.3). The first-run step renders AFTER the
  // real workspace mounts behind the overlay, and the workspace terminal
  // autofocuses its textarea on mount — which fires after our initial focus
  // rAF above and lands focus behind the dialog. The boundary sentinels only
  // wrap Tab once focus is already inside the dialog, so they cannot catch that
  // steal. This document focusin guard pulls focus back into the dialog whenever
  // it escapes to the obscured workspace, for as long as the overlay is visible.
  useEffect(() => {
    if (!visible) return undefined
    const recoverFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current
      if (!dialog) return
      const target = event.target
      if (target instanceof Node && dialog.contains(target)) return
      // Focus left the dialog entirely (e.g. terminal autofocus behind the
      // overlay). Return it to the surface; Tab from there re-enters the trap.
      surfaceRef.current?.focus()
    }
    document.addEventListener('focusin', recoverFocus)
    return () => document.removeEventListener('focusin', recoverFocus)
  }, [visible])

  // Keyboard focus trap (WCAG 2.4.3), matching the canonical Drawer/Modal
  // primitives: sentinel tab stops bracket the surface so Tab/Shift+Tab wrap
  // within the dialog and never reach the real workspace behind the overlay on
  // the first-run step. No Escape/backdrop dismiss — the primary button is the
  // only way forward on a fresh install (see header note).
  const trapFocus = useCallback(
    (position: 'start' | 'end') => () => {
      const root = surfaceRef.current
      if (!root) return
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute('data-focus-sentinel'),
      )
      if (focusables.length === 0) {
        root.focus()
        return
      }
      if (position === 'start') focusables[focusables.length - 1].focus()
      else focusables[0].focus()
    },
    [],
  )

  if (!visible) return null

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="overlay-scrim fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
    >
      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('start')} className="sr-only" />

      <div
        ref={surfaceRef}
        tabIndex={-1}
        className="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-[560px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)] outline-none"
      >
        {step === 'welcome' ? (
          <WelcomeStep titleId={titleId} onContinue={advanceOnboarding} />
        ) : step === 'theme' ? (
          <ThemeStep titleId={titleId} onContinue={advanceOnboarding} />
        ) : step === 'essentials' ? (
          <EssentialsStep titleId={titleId} onContinue={advanceOnboarding} />
        ) : step === 'modules' ? (
          <ModulesStep
            titleId={titleId}
            overrides={overrides}
            onToggle={setModuleEnabled}
            onContinue={advanceOnboarding}
          />
        ) : (
          <FirstRunStep
            titleId={titleId}
            onContinue={advanceOnboarding}
            hasConfiguredCli={hasConfiguredCli}
            onLaunchFirstAgent={onLaunchFirstAgent}
            onOpenCommandPalette={onOpenCommandPalette}
          />
        )}
      </div>

      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('end')} className="sr-only" />
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

// Theme step — reuses AppThemePicker verbatim against the existing
// appSettings.appearance.theme / setAppearanceTheme action. Switching is live
// (useAppTheme drives <html data-theme> from the same store value), so the
// surface behind/around the picker updates immediately.
function ThemeStep({ titleId, onContinue }: { titleId: string; onContinue: () => void }) {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const setAppearanceTheme = useWorkspaceStore((s) => s.setAppearanceTheme)

  return (
    <>
      <div className="border-b border-[color:var(--border-subtle)] px-6 py-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          Pick a theme
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
          Choose how Multicode looks. It applies right away, and you can change it anytime in
          Settings → Appearance.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <AppThemePicker value={theme} onChange={setAppearanceTheme} />
      </div>

      <div className="flex justify-end border-t border-[color:var(--border-subtle)] px-6 py-4">
        <PrimaryButton size="md" onClick={onContinue}>
          Continue
        </PrimaryButton>
      </div>
    </>
  )
}

// Essentials step — the agent-CLI setup that used to be its own `cli` step.
// This step is the home for first-run tooling: T3 adds an "adopt existing agent
// config" affordance and T4 adds an extensions teaser, each as a sibling section
// in the scrollable body below. Keep those additions inside this body region.
function EssentialsStep({ titleId, onContinue }: { titleId: string; onContinue: () => void }) {
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const refreshPluginCatalog = useWorkspaceStore((s) => s.refreshPluginCatalog)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  const setPendingAgentConfigAdoption = useWorkspaceStore((s) => s.setPendingAgentConfigAdoption)
  const rows = useMemo(() => orderInstalledPlugins(pluginCatalogEntries), [pluginCatalogEntries])

  // Skipping the step opts out of everything on it, including any default-on
  // config-adoption selection the card recorded — so a user who skips never
  // imports config at workspace creation. Continue keeps the card's selection.
  const handleSkip = () => {
    setPendingAgentConfigAdoption(null)
    onContinue()
  }

  return (
    <>
      <div className="border-b border-[color:var(--border-subtle)] px-6 py-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          Set up an agent CLI
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
          Multicode runs coding agents through a CLI like Claude or Codex. Install one now, or skip and
          configure your own command later in Settings.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-3">
        {/* Section: agent CLIs. T3 (adopt existing config) and T4 (extensions
            teaser) add their own sibling sections within this body region. */}
        {rows.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-[color:var(--text-muted)]">
            No agent CLIs are available to install.
          </p>
        ) : (
          <div className="divide-y divide-[color:var(--border-subtle)]">
            {rows.map((plugin) => {
              const override = cliRuntimeForPlugin(plugin.id, cliRuntimes)
              return (
                <CliInstallControl
                  key={plugin.id}
                  cli={plugin.id}
                  displayName={plugin.displayName}
                  binary={plugin.binary}
                  command={override.command}
                  useWsl={override.useWsl}
                  onInstalled={(result) => {
                    if (result.resolvedPath && !override.command) {
                      setCliRuntime(plugin.id, { command: result.resolvedPath, useWsl: override.useWsl })
                    }
                    void refreshPluginCatalog()
                    void refreshCliAvailability({ force: true, cliRuntimes })
                  }}
                />
              )
            })}
          </div>
        )}

        {/* Section: adopt existing agent config (T3). Detects an existing Claude
            Code / Codex setup and records which detected MCP servers / skills to
            bring into the first workspace; the real adoption runs at workspace
            creation. Self-manages its own honest empty/error/found states. */}
        <AdoptConfigCard />

        {/* Section: extensions teaser (T4). A discovery beat over the real
            extensions registry; its CTA opens the real Settings → Extensions
            Browse surface (where the existing install flow lives). Self-manages
            its own honest loading/offline/error/empty states. */}
        <ExtensionsTeaser />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-subtle)] px-6 py-4">
        <span
          title="You can change this anytime in Settings → Agents."
          className="min-w-0 truncate text-[11px] text-[color:var(--text-subtle)]"
        >
          You can change this anytime in Settings → Agents.
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <GhostButton
            size="md"
            onClick={handleSkip}
            className="text-[color:var(--text-muted)]"
          >
            Skip for now
          </GhostButton>
          <PrimaryButton size="md" onClick={onContinue}>
            Continue
          </PrimaryButton>
        </div>
      </div>
    </>
  )
}

function ModulesStep({
  titleId,
  overrides,
  onToggle,
  onContinue,
}: {
  titleId: string
  overrides: Parameters<typeof ModuleToggleList>[0]['overrides']
  onToggle: Parameters<typeof ModuleToggleList>[0]['onToggle']
  onContinue: () => void
}) {
  return (
    <>
      <div className="border-b border-[color:var(--border-subtle)] px-6 py-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          What’s included
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
          Everything’s switched on to start. Turn off anything you don’t need, or just continue —
          you can change this anytime in Settings.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <ModuleToggleList overrides={overrides} onToggle={onToggle} />
      </div>

      <div className="flex justify-end border-t border-[color:var(--border-subtle)] px-6 py-4">
        <PrimaryButton size="md" onClick={onContinue}>
          Continue
        </PrimaryButton>
      </div>
    </>
  )
}

// First-run step — the activation payoff, rendered as an overlay AFTER the first
// workspace is created (WorkspaceManager advances onboardingStep to 'first-run'
// on creation). T6 fills the body with the real first-agent-run / command-palette
// payoff; until then this scaffold confirms the workspace is ready and lets the
// user finish onboarding. Keep T6's payoff inside the body region below.
function FirstRunStep({
  titleId,
  onContinue,
  hasConfiguredCli,
  onLaunchFirstAgent,
  onOpenCommandPalette,
}: {
  titleId: string
  onContinue: () => void
  hasConfiguredCli: boolean
  onLaunchFirstAgent: () => void
  onOpenCommandPalette: () => void
}) {
  // The deferred config-adoption outcome (T3) is surfaced inside the payoff body.
  const adoption = useWorkspaceStore((s) => s.agentConfigAdoptionResult)
  return (
    <>
      <div className="border-b border-[color:var(--border-subtle)] px-6 py-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          Your workspace is ready
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
          That’s the setup done. Start your first agent, or just open your workspace.
        </p>
      </div>

      {/* T6: the real first-run activation payoff — launches a real agent run
          when a CLI is configured, otherwise opens the real command palette. */}
      <FirstRunPayoff
        hasConfiguredCli={hasConfiguredCli}
        onLaunchFirstAgent={onLaunchFirstAgent}
        onOpenCommandPalette={onOpenCommandPalette}
        onDone={onContinue}
        adoption={adoption}
      />
    </>
  )
}
