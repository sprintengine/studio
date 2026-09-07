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
// **Which row it opens on.** A card declaring `require.cli` opens on that
// runtime and offers only its rows, with a quiet line saying the card asked for
// it. Frame 4's note says "opens the picker on that runtime"; offering the
// others as well would be offering a launch the run cannot honour, because
// `require.cli` is the verb that makes the harness the card's skills were
// copied into the harness the chat opens in (item 2469) — a person who picked
// Codex on a Claude Code card would get a Codex model id on a Claude Code
// launch, which is not a choice, it is a mismatch. Everything else opens on the
// row the person used last, resolved the way the composer resolves it. A card
// naming a CLI this machine does not have says so on that row, with the route
// to install one, rather than opening empty.

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
 */
export type CardLaunchChoice = {
  cli: AgentCli
  model: string | null
  reasoning: string | null
  permissionPreset: SprintEngineCliPermissionPreset
}

// A general agent, always. A card names a capability, not a role, and the role
// modifier is the spawn picker's own control — the same reading "Hand to agent"
// took. Keying off General also means the picker opens on the engine the person
// last chose here and a pick writes that default back, which is the whole of
// "otherwise the last-used row leads".
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
}: {
  card: HostedCard
  /** The row was clicked. The host closes the popover and starts the run. */
  onChoose: (choice: CardLaunchChoice) => void
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

  const required = cardRequiredCli(card)
  const requiredOption = required
    ? composer.agentCliOptions.find((option) => option.value === required) ?? null
    : null
  // Only the required runtime when the card names one and this machine has it;
  // the whole catalogue otherwise. See the note at the top of this file.
  const options = requiredOption ? [requiredOption] : composer.agentCliOptions
  const currentCli = requiredOption ? requiredOption.value : composer.cliForSelection(CARD_SELECTION)

  // One row, chosen. The engine is written back as General's remembered default
  // AND handed to the run: the launch must be exactly the row that was clicked,
  // and the next open must land on it. Both are needed because a spawn that
  // wrote its default and read it back in the same event would read the value
  // from before the write — the spawn picker's own ruling.
  const choose = (cli: AgentCli, model: string | null): void => {
    composer.setEngineModel(CARD_SELECTION, cli, model)
    onChoose({
      cli,
      model,
      reasoning: composer.reasoningForSelection(CARD_SELECTION, cli) ?? null,
      permissionPreset: resolveModelPermissionPreset(cli, model, permissionFallback),
    })
  }

  // A card that asks for a runtime this machine does not have says which one,
  // on the row, with the way to get it — rather than opening on an empty list
  // or on somebody else's CLI. It is the same sentence the executor would
  // otherwise say in a toast after the press, moved to before it.
  if (required && !requiredOption) {
    return (
      <div className="w-[380px] max-w-[calc(100vw-2rem)] py-1">
        <div className="px-3 py-1.5 text-micro text-[color:var(--text-muted)]" role="status">
          This card runs on {required}, which is not installed.
        </div>
        <CliInstallRosterRow />
      </div>
    )
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
        <CliInstallRosterRow />
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
      // free wherever the CLI declares the axis and is absent everywhere else.
      effectiveReasoningFor={(cli) => composer.reasoningForSelection(CARD_SELECTION, cli)}
      onSelectReasoning={(cli, next) => composer.setEngineReasoning(CARD_SELECTION, cli, next)}
      showReasoning
      reasoningAriaLabel="Reasoning effort"
      onSelectCli={(cli) => choose(cli, null)}
      onSelectModel={(cli, model) => choose(cli, model)}
      // The quiet line Frame 4 draws beside the group heading. It sits in the
      // surface's own leading footer slot rather than on a heading this host
      // would have to invent, which is what keeps the picker the shipped one.
      {...(requiredOption
        ? {
            footer: (
              <span className="px-1.5 text-micro text-[color:var(--text-subtle)]">
                The card asks for {requiredOption.label}.
              </span>
            ),
          }
        : {})}
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
