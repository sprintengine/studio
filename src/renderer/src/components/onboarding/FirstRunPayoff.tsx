import type { AgentConfigAdoptionResult } from '../../types/workspace'
import { GhostButton, PrimaryButton } from '../ui'
import { AgentConfigAdoptionStatus } from './agentConfigAdoption'

// The primary CTA always performs a REAL app action, then finishes onboarding so
// the action's result is visible behind the dismissed overlay. Extracted as a
// pure function so the "real action, never simulated" contract (AC1/AC2/AC3) is
// directly testable without a DOM.
export function runFirstRunPayoffAction(
  hasConfiguredCli: boolean,
  actions: {
    onLaunchFirstAgent: () => void
    onOpenCommandPalette: () => void
    onDone: () => void
  },
): void {
  if (hasConfiguredCli) actions.onLaunchFirstAgent()
  else actions.onOpenCommandPalette()
  actions.onDone()
}

// First-run activation payoff (T6). Rendered as the body + footer of the
// first-run onboarding step, after the workspace is created. It performs a REAL
// action, never a simulated one:
//   - a CLI is configured → launch a real first agent run in the just-created
//     workspace via the existing run-launch path (createNewChat, supplied by
//     WorkspaceManager as onLaunchFirstAgent);
//   - no CLI configured → open the real CommandPalette as an honest
//     learn-by-doing beat (onOpenCommandPalette = runCommand('commandPalette.open')).
// Either way it then finishes onboarding (onDone) so the chosen action's result
// is visible behind the dismissed overlay. "Open workspace" is the plain dismiss.
// Stays inside the OnboardingFlow dialog (semantics + focus owned by the parent).
export function FirstRunPayoff({
  hasConfiguredCli,
  onLaunchFirstAgent,
  onOpenCommandPalette,
  onDone,
  adoption,
}: {
  hasConfiguredCli: boolean
  onLaunchFirstAgent: () => void
  onOpenCommandPalette: () => void
  onDone: () => void
  adoption: AgentConfigAdoptionResult | null
}) {
  // Hold the user here while a deferred config adoption (T3) is still writing, so
  // its success/failure is never hidden by dismissing the overlay early.
  const adopting = adoption?.status === 'adopting'

  const runPrimary = () =>
    runFirstRunPayoffAction(hasConfiguredCli, { onLaunchFirstAgent, onOpenCommandPalette, onDone })

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
        <AgentConfigAdoptionStatus adoption={adoption} />
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          {hasConfiguredCli
            ? 'Your agent is ready. Open a chat in this project and hand it a first task — or just open your workspace.'
            : 'No agent CLI is set up yet. Open the command palette to explore what you can do, or add a CLI in Settings → Agents.'}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[color:var(--border-subtle)] px-6 py-4">
        <GhostButton
          size="md"
          onClick={onDone}
          disabled={adopting}
          className="text-[color:var(--text-muted)]"
        >
          Open workspace
        </GhostButton>
        <PrimaryButton size="md" onClick={runPrimary} disabled={adopting}>
          {adopting ? 'Finishing setup…' : hasConfiguredCli ? 'Run your first agent' : 'Open command palette'}
        </PrimaryButton>
      </div>
    </>
  )
}
