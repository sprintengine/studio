import type { OnboardingStep } from '../../store/onboardingState'
import type { AgentConfigAdoptionResult, PendingAgentConfigAdoption } from '../../types/workspace'
import { LifecycleGlyph, Spinner } from '../ui'

// Shared, store-free helpers for the deferred first-run config adoption (T3) so
// the rule and the read-out can be unit-tested without the renderer store.

export const ADOPTION_MISSING_ROOT_MESSAGE =
  'Couldn’t bring over your setup — this workspace has no project folder. Add it later from Settings.'

export type DeferredAdoptionPlan =
  | { kind: 'skip' }
  | { kind: 'missing-root'; result: Extract<AgentConfigAdoptionResult, { status: 'failed' }> }
  | { kind: 'adopt'; workspaceRoot: string; mcpServerKeys: string[]; skillKeys: string[] }

// Decide what the post-create hook should do with the essentials-step selection:
// - skip: onboarding already finished, or nothing is selected (covers the user
//   who skipped — the selection was cleared — so adoptAgentConfig is never called);
// - missing-root: a selection exists but there is no real workspace folder to
//   write to, so fail honestly instead of silently dropping it;
// - adopt: run the real adoptAgentConfig against the validated root.
export function planDeferredAdoption(input: {
  onboardingStep: OnboardingStep
  selection: PendingAgentConfigAdoption | null
  workspaceRoot: string | null
}): DeferredAdoptionPlan {
  if (input.onboardingStep === 'complete') return { kind: 'skip' }
  const selection = input.selection
  if (!selection || (selection.mcpServerKeys.length === 0 && selection.skillKeys.length === 0)) {
    return { kind: 'skip' }
  }
  const root = input.workspaceRoot?.trim() ? input.workspaceRoot : null
  if (!root) {
    return { kind: 'missing-root', result: { status: 'failed', message: ADOPTION_MISSING_ROOT_MESSAGE } }
  }
  return { kind: 'adopt', workspaceRoot: root, mcpServerKeys: selection.mcpServerKeys, skillKeys: selection.skillKeys }
}

export function describeAdoptionCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// Honest read-out of the deferred config adoption, surfaced on the first-run
// overlay. Renders nothing unless an adoption actually ran this session: an
// in-flight line while the real adoptAgentConfig IPC writes, a shape-coded
// success summary with real counts, or the real failure message. Never a
// fabricated success. Pure (props only).
export function AgentConfigAdoptionStatus({ adoption }: { adoption: AgentConfigAdoptionResult | null }) {
  if (!adoption) return null

  if (adoption.status === 'adopting') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
        <Spinner className="icon-sm shrink-0" />
        Bringing over your existing setup…
      </div>
    )
  }

  if (adoption.status === 'failed') {
    return (
      <div className="flex items-start gap-2">
        <LifecycleGlyph state="failed" label="Adoption failed" live={false} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-[12px] text-[color:var(--text-default)]">Couldn’t bring over your existing setup.</p>
          <p className="mt-0.5 text-[11px] leading-5 text-[color:var(--text-muted)]">{adoption.message}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-[color:var(--text-subtle)]">
            You can add it later from Settings.
          </p>
        </div>
      </div>
    )
  }

  const nothingAdopted = adoption.mcpServerCount === 0 && adoption.skillCount === 0
  return (
    <div className="flex items-start gap-2">
      <LifecycleGlyph state="done" label="Adopted existing setup" live={false} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[12px] text-[color:var(--text-default)]">
          {nothingAdopted
            ? 'Nothing to bring over from your existing setup.'
            : `Brought over ${describeAdoptionCount(adoption.mcpServerCount, 'MCP server')} and ${describeAdoptionCount(
                adoption.skillCount,
                'skill',
              )}.`}
        </p>
        {adoption.warnings.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {adoption.warnings.map((warning, index) => (
              <li key={`${index}:${warning}`} className="text-[11px] leading-5 text-[color:var(--text-muted)]">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
