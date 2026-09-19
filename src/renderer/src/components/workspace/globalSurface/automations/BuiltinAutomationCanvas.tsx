import type { JSX } from 'react'
import type { BuiltinAutomation } from '../../../../../../shared/automations/builtin'
import { DefinitionList, InlineNotice, Section } from '../../../ui'
import { BUILTIN_PERMISSION_LABEL, builtinFacts } from './builtinAutomations'

// The card for one of the five automations that ship inside the app (Extensions
// drawer ruling, 2026-09-05, frame 4). It reads exactly like the canvas for a
// project's own automation — the facts first, unlabeled and stable, then the
// prompt — because it IS the same thing, one step earlier: nothing here has run,
// so there is no run history under it and no state to report.
//
// Nothing on this card is editable, and that is the ruling rather than an
// omission: a built-in is a template every project takes its own copy of, so
// editing happens on the copy, in the editor the rail's Edit already opens. A
// control that appeared to edit the shipped record would either lie or fork the
// five into per-machine variants nothing could update.
//
// The "Built in" tag and the "Add to <project>" primary live in the surface bar
// (GlobalSurfaceShell), where the name is — one title row, one call to action.
export function BuiltinAutomationCanvas({
  entry,
  cliLabel,
  addedIn,
  addBlockedReason,
  addError,
}: {
  entry: BuiltinAutomation
  /** What the run will launch on: the app's last-selected CLI, resolved by the
   *  door, because the built-in's own payload names none. */
  cliLabel: string
  /** The project that already holds a copy, if any — named, because "added" is
   *  only ever true OF a project. */
  addedIn: string | null
  /** Why the bar's Add is off, when it is off for a reason a person can act on.
   *
   *  It is said HERE, in the reading order, rather than only on the control: a
   *  `disabled` button is not focusable, so a reason carried only by its label
   *  is unreachable to anyone tabbing the surface. The button stays `disabled`
   *  rather than becoming `aria-disabled` because the kit's PrimaryButton
   *  paints its off state through `:disabled` alone (ui/Buttons.tsx —
   *  `disabled:opacity-45`, plus the per-variant `disabled:hover:` guards);
   *  swapping the attribute would leave the control painted as live and force
   *  this one call site to re-spell the primitive's own state styling. */
  addBlockedReason: string | null
  addError: string | null
}): JSX.Element {
  const prompt = entry.action.config.prompt.trim()
  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5">
      <div className="mx-auto flex max-w-[720px] flex-col gap-4">
        {addError ? <InlineNotice tone="error">{addError}</InlineNotice> : null}
        <p className="text-body leading-5 text-[color:var(--text-default)]">{entry.description}</p>
        {addedIn ? (
          // A receipt, not a status: `InlineNotice` is the degraded-state idiom
          // (error/warn only, by design), and nothing here is degraded. A quiet
          // line is what the fact deserves — it names WHERE the copy went, which
          // is the part a cross-project surface cannot leave to inference, and
          // where to go on editing it.
          <p className="text-meta leading-5 text-[color:var(--text-subtle)]">
            {`Added to ${addedIn}. It is under Yours, where it can be edited, paused and run.`}
          </p>
        ) : addBlockedReason ? (
          <p className="text-meta leading-5 text-[color:var(--text-subtle)]">{addBlockedReason}</p>
        ) : null}

        <DefinitionList
          className="py-1"
          items={builtinFacts(entry, BUILTIN_PERMISSION_LABEL, cliLabel).map((fact) => ({
            term: fact.term,
            // The cron line is the machine's half of the fact and is set as
            // code, beside the same schedule in words — the mockup's own
            // pairing, and what keeps "0 2 * * *" from reading as prose.
            description: fact.code ? (
              <>
                <code className="font-mono">{fact.code}</code>
                {` · ${fact.description}`}
              </>
            ) : (
              fact.description
            ),
          }))}
        />

        <Section title="Prompt" count={undefined}>
          {/* Read-only, and shaped as the thing it is: the text handed to the
              agent verbatim. Monospace and pre-wrapped so a prompt written in
              paragraphs and file paths survives the reading. */}
          <pre className="max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2 font-mono text-micro leading-[var(--text-line-relaxed)] text-[color:var(--text-muted)]">
            {prompt}
          </pre>
        </Section>
      </div>
    </div>
  )
}
