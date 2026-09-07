// What `Go` opens, and what starts the run (owner ruling R4b, 2026-09-06, item
// 2473; `2026-09-06-extensions-home.html`, Frame 4).
//
// Pressing Go does not run the card. It opens the model picker, and CHOOSING A
// ROW is what runs it — the installs, the chat, the prompt, all under the model
// on the row that was clicked. There is no second confirm and there is nothing
// here to agree to.
//
// **This is not the consent screen R4 removed.** That screen asked *may I
// install these three things*, in engineering vocabulary, about a decision the
// card had already explained in a sentence. This asks *which model, and how
// much rope* — a question only the person can answer, in the control every
// other agent in this product is spawned from (the ruling of 2026-08-04, "the
// model picker is the spawner"). The person chooses HOW TO RUN; they are never
// asked WHETHER TO INSTALL (R4a). A card that could only proceed by asking is a
// card CI refuses to publish, so that question never reaches this popover.
//
// **The picker is the shipped one, not a second one.** The surface below is
// `CliModelPopoverSurface` — the same surface the New chat engine control, the
// spawn picker and a Backlog item's "Hand to agent" open — wired through
// `useAgentComposer` exactly as `AgentComposer.tsx` and
// `BacklogHandToAgentButton.tsx` wire it. The one thing this host does
// differently is the trigger, and only because a card already has exactly one
// control and it is called Go.
//
// **The preset is not a new axis and nothing new is stored.** Since 2026-09-05
// a permission preset is a property of the model row, remembered against
// `modelFavouriteKey` (`<cli>:<model>`) and falling back to
// `appSettings.lastAgentSpawnPermissionPreset` for a row nobody has touched. So
// the footer here is `SpawnPermissionFooter`, the same chip the other hosts
// pass, and the value that rides the launch is read from the row that was
// clicked at the moment it was clicked.
//
// **Which row it opens on, and which rows it offers.** A card declaring
// `require.cli` PRESELECTS that runtime — the picker opens standing on it, with
// the quiet line Frame 4 draws on its group heading — and that is the whole of
// what `require.cli` does here. It does not shorten the list. Frame 4 draws a
// Codex group under the Claude Code group for exactly this reason, and the code
// agrees with the drawing: a card's skills are not installed into one harness.
// `installSkill` is called with no harness at all, so `resolveInstalledSkillHarnesses`
// copies the skill into `.agents` and into the native skills directory of every
// skills-capable CLI on the machine — a Codex chat opened from a `claude-code`
// card finds the skill in `.codex`. Withholding the other runtimes would
// therefore withhold launches that work. What `require.cli` is still for is
// failing the card outright when the machine does not have that CLI, which is
// main's check and not this one's.
//
// **The row that is chosen is the row that launches, whole.** Its cli, its
// model, its effort and its preset leave here as one object and are never split
// apart downstream — the bug that hid behind the shortened list was a launch
// taking its runtime from `require.cli` and its model from the picked row.
// Everything else opens on the row the person used last, resolved the way the
// composer resolves it. A card naming a CLI this machine does not have says so,
// with the route to install one, rather than opening empty — but only once the
// catalogue has actually answered, because "not installed" said about a runtime
// that is installed is worse than a moment of nothing.

import React from 'react'

import { CliModelPopoverSurface } from '../../../../ui'
import { resolveModelPermissionPreset } from '../../../../ui/modelPermissionPresets'
import { CliInstallRosterRow } from '../../../cliInstallRoute'
import { SpawnPermissionFooter } from '../../../agentComposer/spawnFooter'
import {
  useAgentComposer,
  type AgentComposerSelection,
} from '../../../agentComposer/useAgentComposer'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../../../../store/slices/settingsSlice'
import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import type { AgentCli, SprintEngineCliPermissionPreset } from '../../../../../types/workspace'
import type { HostedCard } from '../../../../../../../shared/hosted-card-feed'

/**
 * The row the person chose, as the run carries it.
 *
 * Four facts and no more: everything else about a launch (the workspace, the
 * skills, the prompt) belongs to the card or to the shell. `model` is null on a
 * runtime's own default row, `reasoning` is null where the CLI declares no
 * effort axis, and `permissionPreset` is resolved from the row rather than from
 * a control standing beside it.
 *
 * The four travel together for the whole of the run and are never recombined
 * with a runtime from somewhere else: a Codex model id on a Claude Code launch
 * is not a choice anybody made, it is two halves of two different answers.
 */
export type CardLaunchChoice = {
  cli: AgentCli
  model: string | null
  reasoning: string | null
  permissionPreset: SprintEngineCliPermissionPreset
}

// A general agent, always. A card names a capability, not a role, and the role
// modifier is the spawn picker's own control — the same reading "Hand to agent"
// took. Keying off General is also how "otherwise the last-used row leads" is
// answered: the picker READS the engine the person last chose for a roleless
// agent. It does not write it back — see `choose` below.
const CARD_SELECTION: AgentComposerSelection = { kind: 'general' }

/** The runtime a card insists on, or null when it names none. */
export function cardRequiredCli(card: HostedCard): AgentCli | null {
  const action = card.go.find((entry) => entry.verb === 'require.cli')
  return action && action.verb === 'require.cli' ? action.cli : null
}

/**
 * The popover body. It is its own component so `useAgentComposer` — which reads
 * the plugin catalogue and the remembered engine defaults — runs only while a
 * popover is open, and not once per card on a page that draws seven of them.
 */
export function CardGoPicker({
  card,
  onChoose,
  onNavigate,
}: {
  card: HostedCard
  /** The row was clicked. The host closes the popover and starts the run. */
  onChoose: (choice: CardLaunchChoice) => void
  /** This popover is leaving the screen because something else is opening over
   *  it (the install route opens Settings). The host shuts it, so a modal does
   *  not close onto a picker still standing underneath. */
  onNavigate: () => void
}): JSX.Element {
  const composer = useAgentComposer({
    showTerminal: false,
    conversationAvailable: false,
    initialSelection: CARD_SELECTION,
  })
  // The app-wide default a row nobody has set still resolves to. The footer
  // writes per-row; this reads the row back at the moment it is clicked, which
  // is what `resolveModelPermissionPreset`'s own docstring asks of a caller.
  const permissionFallback = useWorkspaceStore(
    (state) => state.appSettings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  )

  // The effort chosen HERE, for this card, held for as long as this popover is
  // open and no longer.
  //
  // The other picker hosts hand the surface the composer's own setters, which
  // write the level into `specialistReasoningDefaults` under the General key —
  // the remembered engine of the person's next New chat. That is right where
  // the control IS the New chat engine control and wrong here: somebody
  // deciding how to run one card must not be silently redecorating a default
  // they cannot see from this page. Worse, the surface writes effort BEFORE any
  // row is chosen, so merely touching the control moved the default for a run
  // that never happened. So the accessors below are card-scoped: they READ the
  // remembered values as their starting point and write nothing back, and the
  // level a person set here leaves on the launch instead.
  const [effort, setEffort] = React.useState<Partial<Record<AgentCli, string | null>>>({})
  const effortFor = (cli: AgentCli): string | undefined =>
    cli in effort ? effort[cli] ?? undefined : composer.reasoningForSelection(CARD_SELECTION, cli)

  const required = cardRequiredCli(card)
  const requiredOption = required
    ? composer.agentCliOptions.find((option) => option.value === required) ?? null
    : null
  // The whole catalogue, always. `require.cli` leads the list; it does not
  // shorten it. See the note at the top of this file.
  const options = composer.agentCliOptions
  const currentCli = requiredOption ? requiredOption.value : composer.cliForSelection(CARD_SELECTION)

  // One row, chosen — and that is the launch. Nothing is written: the run
  // carries the row, and the person's remembered New-chat engine is theirs.
  const choose = (cli: AgentCli, model: string | null): void => {
    onChoose({
      cli,
      model,
      reasoning: effortFor(cli) ?? null,
      permissionPreset: resolveModelPermissionPreset(cli, model, permissionFallback),
    })
  }

  // With no agent CLI on this machine at all there is no row that could run the
  // card; the install route is the only honest content (as in the spawn picker
  // and in "Hand to agent").
  if (composer.noAgentCliInstalled) {
    return (
      <div className="w-[380px] max-w-[calc(100vw-2rem)] py-1">
        <div className="px-3 py-1.5 text-micro text-[color:var(--text-muted)]" role="status">
          No agent CLI is installed.
        </div>
        <CliInstallRosterRow onNavigate={onNavigate} />
      </div>
    )
  }

  // A card that asks for a runtime this machine does not have says which one,
  // with the way to get it — rather than opening on somebody else's CLI. It is
  // the same sentence the executor would otherwise say in a toast after the
  // press, moved to before it.
  //
  // Gated on the catalogue having ANSWERED. Before it does, `buildAgentCliCatalog`
  // falls back to the legacy list — three runtimes and whatever is persisted —
  // while `resources/plugins/` ships a dozen, so a cold press on a card that
  // requires Cursor would have been told Cursor is not installed while it was.
  if (required && !requiredOption && composer.catalogStatus === 'ready') {
    return (
      <div className="w-[380px] max-w-[calc(100vw-2rem)] py-1">
        <div className="px-3 py-1.5 text-micro text-[color:var(--text-muted)]" role="status">
          This card runs on {required}, which is not installed.
        </div>
        <CliInstallRosterRow onNavigate={onNavigate} />
      </div>
    )
  }

  // An unresolved catalogue is not an empty one — saying "no models" about a
  // machine we have not finished asking would be a lie the person acts on.
  if (options.length === 0 && composer.catalogStatus !== 'ready') {
    return (
      <div
        className="w-[380px] max-w-[calc(100vw-2rem)] px-3 py-2 text-micro text-[color:var(--text-muted)]"
        role="status"
      >
        {composer.catalogStatus === 'error'
          ? composer.catalogError ?? 'Could not load agent plugins.'
          : 'Loading installed agents…'}
      </div>
    )
  }

  return (
    <CliModelPopoverSurface
      ariaLabel={`Run ${card.title}`}
      options={options}
      currentCli={currentCli}
      effectiveModelFor={(cli) => composer.modelForSelection(CARD_SELECTION, cli)}
      // Effort is a property of the model, so it belongs in the model's own
      // picker here exactly as it does in the New chat engine control. It comes
      // free wherever the CLI declares the axis and is absent everywhere else —
      // and here it is held for this card rather than remembered for every
      // agent after it.
      effectiveReasoningFor={(cli) => effortFor(cli)}
      onSelectReasoning={(cli, next) => setEffort((held) => ({ ...held, [cli]: next }))}
      showReasoning
      reasoningAriaLabel="Reasoning effort"
      onSelectCli={(cli) => choose(cli, null)}
      onSelectModel={(cli, model) => choose(cli, model)}
      // The quiet line Frame 4 draws on the group heading of the runtime the
      // card asked for, which is where the drawing puts it — the trailing row's
      // `footer` slot is the host's control cluster, not a place for a sentence
      // about the list above it.
      {...(requiredOption ? { groupNote: { cli: requiredOption.value, note: 'the card asks for this one' } } : {})}
      // Permissions sit with the model, remembered against the row — the same
      // control every other picker host carries, so the preset a person set for
      // a model in New chat is the preset this card launches on.
      permissions={
        <SpawnPermissionFooter
          cli={currentCli}
          model={composer.modelForSelection(CARD_SELECTION, currentCli) ?? null}
          fallback={permissionFallback}
        />
      }
    />
  )
}
