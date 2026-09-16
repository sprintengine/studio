import React from 'react'
import CliIcon from '../../CliIcon'
import { ChipButton, CliModelPickerButton, CloseIconButton, EmptyState, FOCUS_RING_WITHIN_INPUT_CLASS, IconButton, Input, MENU_LIST_CLASS, MenuDivider, MenuItem, MenuOption, PanelHeader, Popover, PrimaryButton, roveMenuFocus, RowButton, StarGlyph, TruncatedText } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { AgentCli, CliPermissionPreset } from '../../../types/workspace'
import { selectAgentCliCatalog } from '../newWorkspace/cliRuntimeOptions'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import { PermissionPresetChips, SpawnDebugToggle, TerminalSessionIcon } from './agentSpawnShared'
import { CliInstallRosterRow } from '../cliInstallRoute'
import { SkillsAndMcpsPicker } from './SkillsAndMcpsPicker'
import {
  useAgentComposer,
  rowMatchesSelection,
  selectionForRow,
  type AgentComposerConfirm,
  type AgentComposerConnector,
  type AgentComposerSelection,
  type ComposerRow,
} from './useAgentComposer'

export type { AgentComposerConfirm, AgentComposerConnector, AgentComposerSelection } from './useAgentComposer'

// One choosable project scope: a folder some open workspace lives in.
type ComposerProjectOption = { path: string; label: string }

type AgentComposerProps = {
  // Where the chat will be created — shown in the panel header as a scoping
  // chip that doubles as a project picker: the open projects plus Browse for a
  // folder the studio doesn't know yet. The host owns the folder state.
  folderPath: string | null
  folderLabel: string | null
  projectOptions: ComposerProjectOption[]
  onSelectProject: (path: string) => void
  onBrowseProject: () => void
  // The remembered agent, preselected on open. Absent → the General row.
  initialSelection: AgentComposerSelection
  // Opens with these MCP servers already picked (the connector surface's "New
  // chat"). The user can still remove any before launch.
  initialMcpServers?: AgentComposerConnector[] | null
  // Shared permission preset (owned by the host so spawn handlers read it at
  // spawn time). Debug mode is transient and defaulted off per spawn.
  permissionPreset: CliPermissionPreset
  onChangePermissionPreset: (preset: CliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  // Confirm creates the chat (host maps to its spawn handlers); close discards.
  onConfirm: (confirm: AgentComposerConfirm) => void
  onClose: () => void
  // Hosted inside another panel (the New workspace door) that already owns the
  // title and Close. When true, the composer drops its own "New chat" title and
  // Close so the surface reads as one panel, not a panel-within-a-panel; the
  // project-scope chip stays as the config region's scoping control.
  embedded?: boolean
}

/**
 * The pre-creation agent composer (panel density). Two columns: the roster is
 * the primary decision (search + the Terminal / General rows), the config
 * column describes the selected agent and binds the engine (CLI + model) to it.
 * Nothing is created until the user confirms; the host's onConfirm performs the
 * actual spawn.
 *
 * The engine controls always reflect the selected agent's remembered CLI/model
 * and persist edits back as that agent's default, so browsing the roster never
 * corrupts a default and the choice the user sees is the choice that spawns.
 */
export default function AgentComposer({
  folderPath,
  folderLabel,
  projectOptions,
  onSelectProject,
  onBrowseProject,
  initialSelection,
  initialMcpServers,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
  onConfirm,
  onClose,
  embedded = false,
}: AgentComposerProps) {
  const composer = useAgentComposer({
    showTerminal: true,
    conversationAvailable: false,
    initialSelection,
    initialMcpServers,
  })
  const { selection, visibleRows } = composer
  const searchRef = React.useRef<HTMLInputElement>(null)
  // The Skills & MCPs picker lists the folder the chat will land in (a null
  // folderPath inherits the active workspace's folder at spawn time).
  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.folderPath ?? null,
  )
  const skillWorkspaceRoot = folderPath ?? activeWorkspaceRoot

  React.useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // The one choke point every spawn goes through: a row click, Enter in the
  // search field, or the CTA. A selection with no row on this machine must not
  // spawn — with no agent CLI installed the roster withholds the rows that
  // launch one, and a remembered pick would otherwise still ride Enter.
  const commit = (target: AgentComposerSelection) => {
    if (!composer.visibleRows.some((row) => rowMatchesSelection(row, target))) return
    onConfirm(composer.buildConfirm(target))
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      composer.moveSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      composer.moveSelection(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit(selection)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const optionId = (row: ComposerRow) => `agent-composer-option-${row.key}`
  const selectedRow = visibleRows.find((row) => rowMatchesSelection(row, selection))
  const quickRows = visibleRows.filter((row) => row.kind === 'terminal' || row.kind === 'general')
  // The General row wears its own bound engine: the model it launches, or the
  // CLI when no model is picked. Resolved from that row's engine, never the
  // highlighted row's — browsing must not repaint it.
  const generalEngine = composer.engineNamesFor({ kind: 'general' })
  const generalLabel = generalEngine.modelLabel ?? generalEngine.cliLabel

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[color:var(--bg-surface)]">
      {/* Standalone, this is the composer's identity row and it draws it with
          the shared primitive — it used to hand-roll the band at `px-4 py-2.5`
          over `--border-subtle`, a taller row on a fainter rule than every
          panel beside it (2112).

          Embedded, the composer is inside a surface that already names it, so
          there is no title to draw and this is a scope strip rather than a
          header. Same `px-3 py-2` either way, so the two presentations start at
          the same height. */}
      {embedded ? (
        <div className="flex items-center gap-3 border-b border-[color:var(--border-default)] px-3 py-2">
          <ProjectScopeChip
            folderPath={folderPath}
            folderLabel={folderLabel}
            options={projectOptions}
            onSelectProject={onSelectProject}
            onBrowseProject={onBrowseProject}
          />
        </div>
      ) : (
        <PanelHeader
          title="New chat"
          scope={
            <ProjectScopeChip
              folderPath={folderPath}
              folderLabel={folderLabel}
              options={projectOptions}
              onSelectProject={onSelectProject}
              onBrowseProject={onBrowseProject}
            />
          }
          primaryAction={<CloseIconButton onClick={onClose} aria-label="Close" />}
        />
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[292px_1fr]">
        {/* Roster column — the primary decision, and the composer's leading
            selection pane: the search field it opens focused drives the list
            below through aria-activedescendant, so focus-within is what says
            the keyboard is here (assets/index.css, "Selection tiers"). */}
        <div
          className="flex min-h-0 flex-col border-r border-[color:var(--border-subtle)] p-3"
          data-selection-pane="primary"
        >
          {/* The wrapper owns the visible border box, so it is what the ring goes
              round — keyed to the input's own focus rather than focus-within, per
              FOCUS_RING_WITHIN_INPUT_CLASS. Ringing the inner input instead drew
              the indicator inside the box (MC-2107). The input still has to say
              `outline-none`: the wrapper's ring replaces the UA one, but the UA
              draws its own on the element that actually holds focus, so without
              it one tab stop wears two rings. */}
          <div className={`mb-2 flex items-center gap-2 rounded border border-[color:var(--border-subtle)] px-2.5 py-1.5 ${FOCUS_RING_WITHIN_INPUT_CLASS}`}>
            <svg className="icon-xs shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            {/* `seamless` is the kit's field for exactly this composition: no
                box of its own, because the wrapper above IS the box. It brings
                the ground, the ink and the placeholder tier, and keeps the
                `outline-none` the wrapper's ring depends on. */}
            <Input
              ref={searchRef}
              variant="seamless"
              fullWidth={false}
              value={composer.query}
              onChange={(event) => composer.setQuery(event.currentTarget.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search agents"
              aria-label="Search agents"
              aria-controls="agent-composer-roster"
              aria-activedescendant={selectedRow ? optionId(selectedRow) : undefined}
              className="min-w-0 flex-1 text-body"
            />
          </div>

          <div
            id="agent-composer-roster"
            role="listbox"
            aria-label="Agents"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {/* No agent CLI on this machine (MC-2093): the composer withholds
                every row that would launch one, and the roster leads with the
                one route that works. Terminal and Conversation launch no CLI,
                so they still render below. */}
            {composer.noAgentCliInstalled ? (
              <div className="pb-1">
                <div className="px-2 py-1 text-micro text-[color:var(--text-muted)]" role="status">
                  No agent CLI is installed.
                </div>
                <CliInstallRosterRow />
              </div>
            ) : null}

            {visibleRows.length === 0 ? (
              composer.noAgentCliInstalled ? null : (
                <EmptyState density="list" title="No matches" />
              )
            ) : (
              <>
                {quickRows.length > 0 ? (
                  <div className="pb-1">
                    {quickRows.map((row) => (
                      <ComposerRosterRow
                        key={row.key}
                        id={optionId(row)}
                        selected={rowMatchesSelection(row, selection)}
                        icon={
                          row.kind === 'terminal' ? (
                            <TerminalSessionIcon className="h-4 w-4" />
                          ) : (
                            <CliIcon cli={composer.cliForSelection({ kind: 'general' })} className="h-4 w-4" />
                          )
                        }
                        label={row.kind === 'terminal' ? 'Terminal' : generalLabel}
                        onSelect={() => composer.setSelection(selectionForRow(row))}
                        onConfirm={() => commit(selectionForRow(row))}
                      />
                    ))}
                  </div>
                ) : null}

              </>
            )}
          </div>
        </div>

        {/* Config column — the selected agent and its engine. The config is
            the column's one scroll region; the attachment chips and the CTA
            row keep their own reserved height below it so overflowing config
            (e.g. a long model list) can never paint underneath them. Its own
            selection pane: the engine's chosen row rests while the roster
            holds focus. */}
        <div className="flex min-h-0 flex-col p-5" data-selection-pane="auto">
          <div className="min-h-0 flex-1 overflow-y-auto">
          <ComposerConfig
            selection={selection}
            generalLabel={generalLabel}
            selectionCli={composer.selectionCli}
            agentCliOptions={composer.agentCliOptions}
            modelFor={(cli) => composer.modelForSelection(selection, cli)}
            reasoningFor={(cli) => composer.reasoningForSelection(selection, cli)}
            onSelectCli={(cli) => composer.setEngineCli(selection, cli)}
            onSelectModel={(cli, model) => composer.setEngineModel(selection, cli, model)}
            onSelectReasoning={(cli, reasoning) => composer.setEngineReasoning(selection, cli, reasoning)}
            permissionPreset={permissionPreset}
            onChangePermissionPreset={onChangePermissionPreset}
            debugMode={debugMode}
            onChangeDebugMode={onChangeDebugMode}
          />
          </div>

          {selection.kind !== 'terminal' ? (
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              {composer.skills.map((skill) => (
                <span
                  key={`skill-${skill.id}`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]"
                >
                  <StarGlyph filled className="icon-xs text-[color:var(--accent-primary)]" />
                  {skill.name}
                  {/* `ink` is the tone for a bare glyph inside something that
                      already has a fill: `--text-subtle` lifting to
                      `--text-default`, and NO ground at any state, so the chip
                      does not grow a second box inside itself. */}
                  <IconButton
                    size="inline"
                    tone="ink"
                    onClick={() => composer.setSkills(composer.skills.filter((entry) => entry.id !== skill.id))}
                    aria-label={`Remove skill ${skill.name}`}
                  >
                    ×
                  </IconButton>
                </span>
              ))}
              {composer.mcpServers.map((server) => (
                <span
                  key={`mcp-${server.id}`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]"
                >
                  <ExtensionIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={16} />
                  {server.name}
                  <IconButton
                    size="inline"
                    tone="ink"
                    onClick={() => composer.setMcpServers(composer.mcpServers.filter((entry) => entry.id !== server.id))}
                    aria-label={`Remove MCP server ${server.name}`}
                  >
                    ×
                  </IconButton>
                </span>
              ))}
              {/* The one picker the New chat composer uses: install and add
                  happen on pick, against the folder the chat will land in. */}
              <SkillsAndMcpsPicker
                workspaceRoot={skillWorkspaceRoot}
                // A conversation agent is not a CLI, so the workspace-wide
                // inventory is what it gets; every other selection launches
                // that CLI.
                pluginId={selection.kind === 'conversation' ? null : composer.selectionCli}
                skills={composer.skills}
                onSkillsChange={composer.setSkills}
                mcpServers={composer.mcpServers}
                onMcpServersChange={composer.setMcpServers}
                placement="top-start"
              />
            </div>
          ) : null}

          <div className="mt-auto flex items-center gap-3 pt-5">
            {/* The chat CTA was the second of five rival primary idioms: an
                accent fill at its own padding-derived height, 40% disabled
                rather than the kit's 45%, and a 6px radius against the kit's
                5px (MC-2113). Same accent, same job — now the same button. */}
            <PrimaryButton size="md" onClick={() => commit(selection)} disabled={!selectedRow}>
              {selection.kind === 'terminal' ? 'Open terminal' : 'Start chat'}
              <kbd className="rounded bg-black/15 px-1 font-mono text-micro">⏎</kbd>
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  )
}

function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2 4.5C2 3.7 2.7 3 3.5 3H6l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9C2.7 13.5 2 12.8 2 12V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function normalizeProjectPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

// The header's project scope: a chip naming the folder the chat will land in,
// opening a picker over the projects already open in the studio plus Browse…
// for a folder the studio doesn't know yet. Selection reports up — the host
// owns the folder state the confirm reads.
function ProjectScopeChip({
  folderPath,
  folderLabel,
  options,
  onSelectProject,
  onBrowseProject,
}: {
  folderPath: string | null
  folderLabel: string | null
  options: ComposerProjectOption[]
  onSelectProject: (path: string) => void
  onBrowseProject: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const currentKey = folderPath ? normalizeProjectPath(folderPath) : null
  // The menu surface, so the rows rove with the arrow keys like every other
  // menu (menu/component.md → Accessibility); focus lands on the first row on
  // open, as ContextMenu does, so the keys work immediately.
  const surfaceRef = React.useRef<HTMLElement | null>(null)
  // Stable identity: `Popover` keys its auto-focus effect on this callback, so an
  // inline arrow function would re-run it on every render and pull the keyboard
  // cursor back to the first row while the menu is open.
  const focusFirstMenuItem = React.useCallback((surface: HTMLElement) => {
    surfaceRef.current = surface
    surface.querySelector<HTMLElement>('[data-menu-item="true"]:not([disabled])')?.focus()
  }, [])
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Project for this chat"
      popupRole="menu"
      placement="bottom-start"
      className="min-w-0"
      surfaceClassName={`w-[300px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusFirstMenuItem}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The kit's chip, which is what this is called and what it is: a
        // content-height pill naming one thing, with the hairline the
        // `outline` variant draws so it stays findable on the header strip.
        <ChipButton
          ref={ref}
          variant="outline"
          onClick={togglePopover}
          {...triggerProps}
        >
          <FolderGlyph className="icon-xs shrink-0" />
          <span className="truncate">{folderLabel ?? 'Choose project'}</span>
          <span aria-hidden="true" className="shrink-0 text-[color:var(--text-disabled)]">▾</span>
        </ChipButton>
      )}
    >
      <div onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}>
        {options.map((option) => {
          const current = currentKey !== null && normalizeProjectPath(option.path) === currentKey
          return (
            // The kit's stacked row shape (name over path): the one sanctioned
            // two-line menu row, with the item's ring, hover and disabled
            // treatment. `data-menu-item` + `tabIndex={-1}` make it a stop for
            // the surface's roving focus, as `MenuItem` is.
            <MenuOption
              key={option.path}
              role="menuitemradio"
              selected={current}
              stacked
              data-menu-item="true"
              tabIndex={-1}
              onClick={() => {
                onSelectProject(option.path)
                setOpen(false)
              }}
              icon={<FolderGlyph className="icon-xs mt-0.5 shrink-0 text-[color:var(--text-muted)]" />}
              trailing={
                current ? (
                  <svg className="icon-sm mt-0.5 shrink-0 text-[color:var(--accent-primary)]" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 5.2l2 2 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null
              }
            >
              <span className="block truncate text-meta">{option.label}</span>
              <span className="block truncate font-mono text-micro text-[color:var(--text-subtle)]">{option.path}</span>
            </MenuOption>
          )
        })}
        {options.length > 0 ? <MenuDivider /> : null}
        <MenuItem
          onClick={() => {
            setOpen(false)
            onBrowseProject()
          }}
          icon={
            <svg className="icon-xs shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          }
        >
          Browse…
        </MenuItem>
      </div>
    </Popover>
  )
}

// A roster option. Selection is the durable state (aria-selected + the accent
// inset bar, reusing the SpawnAgentMenu highlight idiom); double-click confirms.
// The last-used agent needs no separate marker — it is the selected row on open.
function ComposerRosterRow({
  id,
  selected,
  icon,
  label,
  onSelect,
  onConfirm,
}: {
  id: string
  selected: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
  onConfirm: () => void
}) {
  return (
    // The kit's full-bleed row: no radius (an inset rounded fill inside a padded
    // pane reads as a card in a card) and an inset focus ring, because the row
    // touches the pane's edge. `selected` paints the neutral selection canon;
    // `aria-current` is withheld because a listbox option states its state in
    // `aria-selected`, which the caller passes.
    <RowButton
      density="bleed"
      selected={selected}
      aria-current={undefined}
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      onDoubleClick={onConfirm}
      className="pl-2.5"
    >
      <span
        className={`flex w-5 shrink-0 justify-center ${
          selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'
        }`}
      >
        {icon}
      </span>
      <TruncatedText as="span" text={label} className="min-w-0 flex-1 text-body" />
    </RowButton>
  )
}

function ComposerConfig({
  selection,
  generalLabel,
  selectionCli,
  agentCliOptions,
  modelFor,
  reasoningFor,
  onSelectCli,
  onSelectModel,
  onSelectReasoning,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
}: {
  selection: AgentComposerSelection
  // The General agent's name: its bound engine, resolved by the caller.
  generalLabel: string
  selectionCli: AgentCli
  agentCliOptions: ReturnType<typeof selectAgentCliCatalog>
  modelFor: (cli: AgentCli) => string | undefined
  reasoningFor: (cli: AgentCli) => string | undefined
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
  onSelectReasoning: (cli: AgentCli, reasoning: string | null) => void
  permissionPreset: CliPermissionPreset
  onChangePermissionPreset: (preset: CliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
}) {
  if (selection.kind === 'terminal') {
    return (
      <div>
        <div className="flex items-center gap-2.5">
          <TerminalSessionIcon className="size-icon-md text-[color:var(--text-strong)]" />
          <span className="text-title font-semibold text-[color:var(--text-strong)]">Terminal</span>
        </div>
        <p className="mt-1 max-w-[46ch] text-body leading-relaxed text-[color:var(--text-muted)]">
          A plain shell in this project's folder — no agent, no model.
        </p>
      </div>
    )
  }

  const name = generalLabel
  const description = 'Runs your instructions as written.'
  const icon = <CliIcon cli={selectionCli} className="size-icon-md text-[color:var(--text-strong)]" />

  return (
    <div>
      <div className="flex items-center gap-2.5">
        {icon}
        <span className="text-title font-semibold text-[color:var(--text-strong)]">{name}</span>
      </div>
      <p className="mt-1 max-w-[52ch] text-body leading-relaxed text-[color:var(--text-muted)]">{description}</p>

      {/* The runtime, as the two controls it is: the model, and the reasoning
          level with its context window. Picking either persists as this agent's
          remembered default. */}
      <div className="mt-5 flex flex-wrap items-center gap-1">
        <CliModelPickerButton
          ariaLabel={`Agent runtime for ${name}`}
          options={agentCliOptions}
          cli={selectionCli}
          effectiveModelFor={modelFor}
          effectiveReasoningFor={reasoningFor}
          onSelectReasoning={onSelectReasoning}
          onSelectCli={onSelectCli}
          onSelectModel={onSelectModel}
          maxWidthClassName="max-w-[260px]"
        />
      </div>

      <div className="mt-5 border-t border-[color:var(--border-subtle)] pt-3">
        <div className="flex flex-wrap items-center gap-1">
          <PermissionPresetChips value={permissionPreset} onChange={onChangePermissionPreset} />
          <SpawnDebugToggle active={debugMode} onChange={onChangeDebugMode} />
        </div>
      </div>
    </div>
  )
}
