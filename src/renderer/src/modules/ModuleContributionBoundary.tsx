// The error boundary around everything a module contributes to the shell's own
// chrome: a panel, a top-bar control, a sidebar row. A module's render throw —
// or its lazy chunk failing to load — used to propagate to the nearest shell
// boundary and take the workspace, the top bar or the whole sidebar down with
// it. Here it stays the module's failure.
//
// Doors and modal surfaces keep their own boundary (globalSurface/
// surfaceErrorBoundary.tsx): they own the card region, so their fallback is a
// full canvas state. A contribution sits among the shell's controls, so its
// fallback is compact — an inline notice for a panel, and for a control in a
// row of controls nothing at all: a notice would push its neighbours about,
// and the crash is reported where the module is managed.

import React from 'react'

import { GhostButton, InlineNotice } from '../components/ui'

// The last crash per module id, as the Settings module list reads it. A plain
// map rather than store state: the list reads it when it renders, and a crash
// is a diagnostic, not something any surface re-renders on.
const contributionErrors = new Map<string, string>()

/** The last render failure of one of this module's contributions, if any. */
export function getModuleContributionError(moduleId: string): string | undefined {
  return contributionErrors.get(moduleId)
}

// The message is what the module threw, so it may carry a path from the
// author's machine; keep the first line and bound it, like a load error.
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n', 1)[0]!.trim()
  return (firstLine || 'The contribution failed to render.').slice(0, 300)
}

export function reportModuleContributionError(moduleId: string, surface: string, error: unknown): void {
  contributionErrors.set(moduleId, `${surface} crashed: ${describeError(error)}`)
  console.error(`[modules] module "${moduleId}" ${surface} crashed`, error)
}

type ModuleContributionBoundaryProps = {
  moduleId: string
  /** What the contribution is, for the report: `panel "acme.board"`, `top-bar item "mic"`. */
  surface: string
  /**
   * `panel` draws a compact notice with a retry; `inline` draws nothing, for a
   * control that sits in a row of the shell's own controls.
   */
  variant: 'panel' | 'inline'
  /** The module's display name for the notice; the id stands in without one. */
  label?: string
  children: React.ReactNode
}

type ModuleContributionBoundaryState = { failed: boolean }

export class ModuleContributionBoundary extends React.Component<
  ModuleContributionBoundaryProps,
  ModuleContributionBoundaryState
> {
  state: ModuleContributionBoundaryState = { failed: false }

  static getDerivedStateFromError(): ModuleContributionBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    reportModuleContributionError(this.props.moduleId, this.props.surface, error)
  }

  componentDidUpdate(previous: ModuleContributionBoundaryProps): void {
    // A reused boundary (a tab switching components, a row list reordering)
    // must not carry one contribution's failure onto the next.
    if (this.state.failed && (previous.moduleId !== this.props.moduleId || previous.surface !== this.props.surface)) {
      // oxlint-disable-next-line react/no-did-update-set-state -- guarded reset, runs once per switch
      this.setState({ failed: false })
    }
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    if (this.props.variant === 'inline') return null
    return (
      <ModuleContributionErrorFallback
        label={this.props.label ?? this.props.moduleId}
        moduleId={this.props.moduleId}
        onRetry={() => this.setState({ failed: false })}
      />
    )
  }
}

// Exported so the failure surface is testable without a real render error.
export function ModuleContributionErrorFallback({
  label,
  moduleId,
  onRetry,
}: {
  label: string
  moduleId: string
  onRetry: () => void
}) {
  return (
    <div className="p-3">
      <InlineNotice
        tone="error"
        title={`${label} hit a problem and stopped. The rest of the app is unaffected.`}
        hint={`From ${moduleId}`}
        action={<GhostButton onClick={onRetry}>Try again</GhostButton>}
      />
    </div>
  )
}
