import type { AgentConfigAdoptionResult } from '../../types/workspace'
import { LifecycleGlyph, Spinner } from '../ui'

// Shared, store-free helpers for the first-run config adoption so the rule and
// the read-out can be unit-tested without the renderer store.
//
// Adoption used to be a question: a card on the wizard's essentials step asked
// which detected MCP servers and skills to bring over, recorded the answer, and
// replayed it at workspace creation. The card is gone, so this now adopts
// everything it finds, once per profile — but it still runs at first workspace
// creation and nowhere earlier, because `agent-config-import.ts` needs a real
// `workspaceRoot` that passes `isDirectory()` and no folder exists before then.

export const ADOPTION_MISSING_ROOT_MESSAGE =
  'Couldn’t bring over your setup — this workspace has no project folder. Add it later from Settings.'

export type AgentConfigAdoptionPlan =
  | { kind: 'skip' }
  | { kind: 'nothing-detected' }
  | { kind: 'missing-root'; result: Extract<AgentConfigAdoptionResult, { status: 'failed' }> }
  | { kind: 'adopt'; workspaceRoot: string; mcpServerKeys: string[]; skillKeys: string[] }

// Decide what to do once detection has run:
// - skip: this profile already adopted, so nothing is offered twice;
// - nothing-detected: there was no existing setup to bring over — a real answer,
//   and a silent one (no read-out for a user who never had Claude Code or Codex);
// - missing-root: there IS something to bring over but no folder to write it to,
//   so fail out loud rather than dropping it silently;
// - adopt: run the real adoptAgentConfig against the validated root.
//
// Note the order: the root is only checked once we know there is something to
// adopt. Checking it first would report "couldn’t bring over your setup" to
// every user who never had one.
export function planAgentConfigAdoption(input: {
  hasAdoptedAgentConfig: boolean
  workspaceRoot: string | null
  detected: { mcpServerKeys: string[]; skillKeys: string[] } | null
}): AgentConfigAdoptionPlan {
  if (input.hasAdoptedAgentConfig) return { kind: 'skip' }
  const detected = input.detected
  if (!detected || (detected.mcpServerKeys.length === 0 && detected.skillKeys.length === 0)) {
    return { kind: 'nothing-detected' }
  }
  const root = input.workspaceRoot?.trim() ? input.workspaceRoot : null
  if (!root) {
    return { kind: 'missing-root', result: { status: 'failed', message: ADOPTION_MISSING_ROOT_MESSAGE } }
  }
  return { kind: 'adopt', workspaceRoot: root, mcpServerKeys: detected.mcpServerKeys, skillKeys: detected.skillKeys }
}

export function describeAdoptionCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// Honest read-out of the config adoption, surfaced as one line in
// Settings → Agents. Renders nothing unless an adoption actually ran this
// session: an in-flight line while the real adoptAgentConfig IPC writes, a
// shape-coded success summary with real counts, or the real failure message.
// Never a fabricated success. Pure (props only).
export function AgentConfigAdoptionStatus({ adoption }: { adoption: AgentConfigAdoptionResult | null }) {
  if (!adoption) return null

  if (adoption.status === 'adopting') {
    return (
      <div className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
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
          <p className="text-meta text-[color:var(--text-default)]">Couldn’t bring over your existing setup.</p>
          <p className="mt-0.5 text-micro leading-5 text-[color:var(--text-muted)]">{adoption.message}</p>
          <p className="mt-0.5 text-micro leading-5 text-[color:var(--text-subtle)]">
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
        <p className="text-meta text-[color:var(--text-default)]">
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
              <li key={`${index}:${warning}`} className="text-micro leading-5 text-[color:var(--text-muted)]">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
