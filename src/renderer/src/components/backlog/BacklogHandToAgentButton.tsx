import React from 'react'

import { CliModelPopoverSurface, GhostButton, Popover, PrimaryButton } from '../ui'
import { CliInstallRosterRow } from '../workspace/cliInstallRoute'
import { SpawnPermissionFooter } from '../workspace/agentComposer/spawnFooter'
import { useAgentComposer, type AgentComposerSelection } from '../workspace/agentComposer/useAgentComposer'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../store/slices/settingsSlice'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getBacklogHandoffHost } from './backlogHandoffHost'
import { canHandBacklogItemToAgent } from '../../utils/backlogHandoff'
import {
  agentBacklogOpenPorts,
  agentLinkForItem,
  hasAgentLink,
  openAgentBacklogLink,
} from '../../utils/agentBacklogLinks'
import type { AgentCli } from '../../types/workspace'
import type { BacklogItem } from '../../utils/backlog'

// ── "Hand to agent" on a Backlog item ────────────────────────────────────────
//
// The shell's primary execute control on a Backlog item: one agent, on a
// model the person picks, started on this item alone. Module actions live in
// the menus (owner ruling 2026-09-15); this button and "Open agent" beside it
// are the header's own. The surface the button opens is `CliModelPopoverSurface`
// — the SAME picker the new-chat engine control opens — and clicking a model
// row IS the handoff, in one action, the way the spawn picker made a model row
// spawn (MC-2122). There is no roster of identities in front of it and no
// confirm step behind it.
//
// What the agent is handed is the Backlog skill's own invocation for the CLI
// that was picked, as its startup prompt — the same composition the automation
// `backlog.work` tool makes — so lifecycle stays with the skill contract and
// this control never touches item status. The link back to the agent is
// recorded by the host, which is what turns on the header's "Open agent"
// control afterwards.
//
// The button lives in the detail pane because it has to OPEN something
// anchored to its own trigger. Agent creation still belongs to the shell, so
// the click routes out through `backlogHandoffHost`.

// A general agent, always: a handoff has one job. The composer hook keys
// General's remembered CLI/model off this selection, so the picker opens on the
// engine the person last chose and a pick here writes that default back.
const HANDOFF_SELECTION: AgentComposerSelection = { kind: 'general' }

export function BacklogHandToAgentButton({
  item,
  workspaceRoot,
}: {
  item: BacklogItem
  /** The item's OWN project root. Empty (a door with no project) hides the button. */
  workspaceRoot: string
}): JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  // Closing on the item changing matters: the pane keeps this button mounted
  // while the person arrows down the list, and a picker left open would hand
  // off the row they moved to, not the one they opened it on.
  React.useEffect(() => setOpen(false), [item.id])

  if (!workspaceRoot.trim() || !canHandBacklogItemToAgent(item)) return null

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Hand ${item.title} to an agent`}
      popupRole="menu"
      placement="bottom-start"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <PrimaryButton ref={ref} onClick={togglePopover} {...triggerProps}>
          Hand to agent
        </PrimaryButton>
      )}
    >
      <HandToAgentPicker item={item} workspaceRoot={workspaceRoot} onClose={() => setOpen(false)} />
    </Popover>
  )
}

// The picker body is its own component so the composer hook — which reads the
// plugin catalog and the remembered engine defaults — only runs while the
// popover is open, not for every selected backlog item.
function HandToAgentPicker({
  item,
  workspaceRoot,
  onClose,
}: {
  item: BacklogItem
  workspaceRoot: string
  onClose: () => void
}): JSX.Element {
  const composer = useAgentComposer({
    showTerminal: false,
    conversationAvailable: false,
    initialSelection: HANDOFF_SELECTION,
  })
  // The app-wide default a model row nobody has set still resolves to. The
  // footer writes per-row; the spawn re-reads the row it launches, so there is
  // no value to carry from here to the handoff.
  const permissionFallback = useWorkspaceStore(
    (state) => state.appSettings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  )
  const footerCli = composer.cliForSelection(HANDOFF_SELECTION)

  // One model row, handed. The engine is written back as General's remembered
  // default AND passed on the request: the launch must be exactly the row that
  // was clicked, and the next open must land on it (the spawn picker's ruling).
  const hand = (cli: AgentCli, model: string | null): void => {
    composer.setEngineModel(HANDOFF_SELECTION, cli, model)
    const host = getBacklogHandoffHost()
    onClose()
    if (!host) return
    void host.handToAgent({
      workspaceRoot,
      relativePath: item.relativePath,
      title: item.title,
      cli,
      model,
    })
  }

  // With no agent CLI on this machine there is no row that could take the item;
  // the install route is the only honest content (as in the spawn picker).
  if (composer.noAgentCliInstalled) {
    return (
      <div className="w-[380px] max-w-[calc(100vw-2rem)] py-1">
        <div className="px-3 py-1.5 text-micro text-[color:var(--text-muted)]" role="status">
          No agent CLI is installed.
        </div>
        <CliInstallRosterRow onNavigate={onClose} />
      </div>
    )
  }

  // An unresolved catalog is not an empty one — saying "no models" about a
  // machine we have not finished asking would be a lie the person acts on.
  if (composer.agentCliOptions.length === 0 && composer.catalogStatus !== 'ready') {
    return (
      <div
        className="w-[380px] max-w-[calc(100vw-2rem)] px-3 py-2 text-micro text-[color:var(--text-muted)]"
        role="status"
      >
        {composer.catalogStatus === 'error'
          ? (composer.catalogError ?? 'Could not load agent plugins.')
          : 'Loading installed agents…'}
      </div>
    )
  }

  return (
    <CliModelPopoverSurface
      ariaLabel="Hand to agent"
      options={composer.agentCliOptions}
      currentCli={footerCli}
      effectiveModelFor={(cli) => composer.modelForSelection(HANDOFF_SELECTION, cli)}
      // Effort is a property of the model, so it belongs in the model's own
      // picker here exactly as it does in the new-chat engine control.
      effectiveReasoningFor={(cli) => composer.reasoningForSelection(HANDOFF_SELECTION, cli)}
      onSelectReasoning={(cli, next) => composer.setEngineReasoning(HANDOFF_SELECTION, cli, next)}
      showReasoning
      reasoningAriaLabel="Reasoning effort"
      onSelectCli={(cli) => hand(cli, null)}
      onSelectModel={(cli, model) => hand(cli, model)}
      // Permissions sit with the model, remembered against the row — the same
      // control the New chat picker carries, so the preset a person set for a
      // model there is the preset this handoff launches on.
      permissions={
        <SpawnPermissionFooter
          cli={footerCli}
          model={composer.modelForSelection(HANDOFF_SELECTION, footerCli) ?? null}
          fallback={permissionFallback}
        />
      }
    />
  )
}

// The shell's second header control: reopen the agent already working this
// item. Not a module action — agent sessions belong to the shell — so it sits
// beside "Hand to agent" rather than in the menus with contributed execute
// actions (owner ruling 2026-09-15).
export function BacklogOpenAgentButton({
  item,
  workspaceId,
  workspaceRoot,
}: {
  item: BacklogItem
  workspaceId: string
  workspaceRoot: string
}): JSX.Element | null {
  if (item.status === 'archived' || !hasAgentLink(item)) return null

  const open = (): void => {
    const link = agentLinkForItem(item)
    if (!link) return
    void (async () => {
      await openAgentBacklogLink({
        workspaceId,
        workspaceRoot,
        item,
        link,
        ports: await agentBacklogOpenPorts(),
      })
    })()
  }

  return <GhostButton onClick={open}>Open agent</GhostButton>
}
