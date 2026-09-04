import React from 'react'

import {
  CliModelPopoverSurface,
  MenuItem,
  Popover,
  Tooltip,
  roveMenuFocus,
  type PickerExtraRow,
  type PickerRailExtra,
} from '../../ui'
import { MENU_GROUP_LABEL_CLASS, MENU_ITEM_CLASS, MENU_LIST_CLASS } from '../../ui/menuClasses'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { AgentCli, SpecialistActionId, SprintEngineCliPermissionPreset } from '../../../types/workspace'
import { AGENT_SPAWN_PERMISSION_OPTIONS, ConversationProviderIcon, TerminalSessionIcon } from './agentSpawnShared'
import { SkillsAndMcpsPicker } from './SkillsAndMcpsPicker'
import { CliInstallRosterRow } from '../cliInstallRoute'
import type { ConversationProviderRow } from '../conversationSpawnOptions'
import { useAgentComposer, type AgentComposerConfirm, type AgentComposerSelection } from './useAgentComposer'

// ── The model picker IS the spawner (MC-2122) ────────────────────────────────
//
// The surface a new-agent trigger opens is `CliModelPopoverSurface` itself:
// clicking a model row spawns that model, in one action. There is no roster of
// identities in front of it any more — the composer's Terminal / General /
// Conversation / one-row-per-specialist list is gone, and with it the second
// hop through a per-row config flyout.
//
// What identity is left has moved to where it costs nothing:
//   · Terminal and Conversation are RAIL entries, below a divider — ways in
//     that are not models, so they share the sidebar rather than the list.
//   · Role is a footer control, default None: a modifier on the next spawn,
//     never a doorway. Set it and the next model row spawns as that specialist.
//   · Permissions take the footer's first-class seat (bottom-right), because a
//     permission preset matters more per spawn than an effort level does.
//   · Effort, start-in-worktree and connector demote into the footer's ⋯ menu —
//     the settings you set once.
//   · A star taken while a role is set captures the PAIR, so the ★ filter
//     becomes a roster the user assembles rather than one the app imposes.
//
// On the Terminal and Conversation filters the footer disappears entirely:
// nothing it configures applies to a shell or to a conversation.

export type SpawnPickerProps = {
  /** The conversation providers this workspace can start; empty hides the rail entry. */
  conversationRows: ConversationProviderRow[]
  /** Spawns into the host's workspace. The picker closes itself afterwards. */
  onSpawn: (confirm: AgentComposerConfirm) => void
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  onClose: () => void
}

// The role the footer is set to, as the composer hook keys its engine defaults:
// a specialist selection is a role, `general` is None. Reusing the hook's
// selection is what keeps "Architect's remembered model" working — the picker
// marks the model that role last spawned on, and starring writes under the
// same key the old roster's engine chip did.
function selectionRole(selection: AgentComposerSelection): SpecialistActionId | null {
  return selection.kind === 'specialist' ? selection.specialistId : null
}

export default function SpawnPicker({
  conversationRows,
  onSpawn,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
  onClose,
}: SpawnPickerProps): JSX.Element {
  const composer = useAgentComposer({
    // Neither is a roster row any more: both are rail entries this surface
    // builds itself, so the hook only carries roles and their engines.
    showTerminal: false,
    conversationAvailable: false,
    initialSelection: { kind: 'general' },
  })
  const role = selectionRole(composer.selection)
  const roleAction = composer.specialistActions.find((action) => action.id === role) ?? null
  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.folderPath ?? null,
  )

  // "Start in worktree" is only offered when the workspace folder is inside a
  // git repository — probed once per open, so a non-repo folder never shows a
  // control whose spawn would fail.
  const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    if (!activeWorkspaceRoot) {
      setWorkspaceIsGitRepo(false)
      return
    }
    void window.api
      .getGitRepoRoot(activeWorkspaceRoot)
      .then((root) => {
        if (!cancelled) setWorkspaceIsGitRepo(Boolean(root))
      })
      .catch(() => {
        if (!cancelled) setWorkspaceIsGitRepo(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceRoot])

  // The terminal row is the shell's own name — `zsh`, `bash` — resolved by the
  // launcher that will run it, so the row cannot advertise one shell and start
  // another. A failed probe falls back to the same last-resort shell the
  // launcher itself would reach for rather than withholding the way in.
  const [shellName, setShellName] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    void window.api
      .terminalDefaultShellName()
      .then((name) => {
        if (!cancelled) setShellName(name.trim() || null)
      })
      .catch(() => {
        if (!cancelled) setShellName(window.api.platform === 'win32' ? 'powershell' : 'sh')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const spawn = (confirm: AgentComposerConfirm): void => {
    onSpawn(confirm)
    onClose()
  }

  // One model row, spawned. The engine is passed on the confirm AND written as
  // the remembered default for this role: the spawn must launch exactly the row
  // that was clicked, and the next open must land on it.
  const spawnModel = (cli: AgentCli, model: string | null, roleId: string | null): void => {
    const target: AgentComposerSelection = roleId
      ? { kind: 'specialist', specialistId: roleId as SpecialistActionId }
      : { kind: 'general' }
    composer.setEngineModel(target, cli, model)
    const confirm = composer.buildConfirm(target, { cli, model })
    // Role resets after a specialist spawn: repetition is what starred
    // compositions are for, and a role that silently persisted would make the
    // next spawn a specialist nobody asked for. Reset BEFORE the spawn, which
    // closes the surface — after it, this would be a write to a dead component.
    if (roleId) composer.setSelection({ kind: 'general' })
    spawn(confirm)
  }

  const railExtras: PickerRailExtra[] = [
    {
      key: 'terminal',
      label: 'Terminal',
      glyph: <TerminalPromptGlyph />,
      emptyLabel: 'No shell reported.',
      rows: shellName
        ? [
            {
              key: `shell:${shellName}`,
              name: shellName,
              mono: true,
              glyph: <TerminalSessionIcon className="size-icon-sm" />,
              onSelect: () => spawn({ kind: 'terminal' }),
            },
          ]
        : [],
    },
    ...(conversationRows.length > 0
      ? [
          {
            key: 'conversation',
            label: 'Chats',
            glyph: <ConversationProviderIcon className="size-icon-sm" />,
            rows: conversationRows.map(
              (row): PickerExtraRow => ({
                key: `conversation:${row.providerId}`,
                name: row.providerLabel,
                detail: row.modelLabel,
                glyph: <ConversationProviderIcon className="size-icon-sm" />,
                onSelect: () =>
                  spawn({
                    kind: 'conversation',
                    provider: { providerId: row.providerId, modelId: row.modelId, modelLabel: row.modelLabel },
                  }),
              }),
            ),
          },
        ]
      : []),
  ]

  // With no agent CLI on this machine the model list is empty and the footer
  // configures a spawn that cannot happen; the install route is the only honest
  // content (MC-2093).
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

  // An unresolved catalog is not an empty one. Rendering the picker here would
  // say "No models here yet." about a machine we have not finished asking, and
  // offer a footer configuring a spawn with nothing to spawn.
  if (composer.agentCliOptions.length === 0 && composer.catalogStatus !== 'ready') {
    return (
      <div className="w-[380px] max-w-[calc(100vw-2rem)] px-3 py-2 text-micro text-[color:var(--text-muted)]" role="status">
        {composer.catalogStatus === 'error'
          ? composer.catalogError ?? 'Could not load agent plugins.'
          : 'Loading installed agents…'}
      </div>
    )
  }

  return (
    <CliModelPopoverSurface
      ariaLabel="Spawn agent"
      options={composer.agentCliOptions}
      currentCli={composer.cliForSelection(composer.selection)}
      effectiveModelFor={(cli) => composer.modelForSelection(composer.selection, cli)}
      railExtras={railExtras}
      composition={{
        role: roleAction ? { id: roleAction.id, label: roleAction.shortLabel } : null,
        roleLabel: (roleId) =>
          composer.specialistActions.find((action) => action.id === roleId)?.shortLabel ?? null,
      }}
      onSelectCli={(cli, roleId) => spawnModel(cli, null, roleId ?? null)}
      onSelectModel={(cli, model, roleId) => spawnModel(cli, model, roleId ?? null)}
      footer={
        <div className="flex items-center gap-1 border-t border-[color:var(--border-subtle)] px-1.5 py-1">
          {composer.specialistActions.length > 0 ? (
            <FooterMenu
              ariaLabel="Role for the next spawn"
              heading="Specialty for next spawn"
              label={`Role · ${roleAction?.shortLabel ?? 'None'}`}
              tone={roleAction ? 'accent' : 'quiet'}
              placement="top-start"
            >
              {(close) => (
                <>
                  <MenuItem
                    selection="one-of"
                    checked={role === null}
                    trailing={<MenuTick shown={role === null} />}
                    onClick={() => {
                      composer.setSelection({ kind: 'general' })
                      close()
                    }}
                  >
                    None
                  </MenuItem>
                  {composer.specialistActions.map((action) => (
                    <MenuItem
                      key={action.id}
                      selection="one-of"
                      checked={role === action.id}
                      trailing={<MenuTick shown={role === action.id} />}
                      onClick={() => {
                        composer.setSelection({ kind: 'specialist', specialistId: action.id })
                        close()
                      }}
                    >
                      {action.shortLabel}
                    </MenuItem>
                  ))}
                </>
              )}
            </FooterMenu>
          ) : null}
          <FooterMenu
            ariaLabel="More spawn options"
            label="⋯"
            tone="quiet"
            placement="top-start"
            tooltip="Reasoning, worktree, connector"
          >
            {(close) => (
              <MoreMenuItems
                composer={composer}
                workspaceRoot={activeWorkspaceRoot}
                worktreeAvailable={workspaceIsGitRepo}
                debugMode={debugMode}
                onChangeDebugMode={onChangeDebugMode}
                close={close}
              />
            )}
          </FooterMenu>
          <span className="flex-1" />
          <FooterMenu
            ariaLabel="Permissions for the next spawn"
            heading="Permissions"
            label={permissionLabel(permissionPreset)}
            tone={permissionPreset === 'bypass' ? 'warn' : permissionPreset === 'auto' ? 'accent' : 'quiet'}
            placement="top-end"
          >
            {(close) => (
              <>
                {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => (
                  <MenuItem
                    key={option.value}
                    selection="one-of"
                    checked={option.value === permissionPreset}
                    trailing={<MenuTick shown={option.value === permissionPreset} />}
                    onClick={() => {
                      onChangePermissionPreset(option.value)
                      close()
                    }}
                  >
                    {/* Bypass is WARN, not danger: `variant="danger"` is the
                        error tone, and the preset wears amber everywhere else
                        in the app. Ink, never a fill — the menu's own rule. */}
                    {option.value === 'bypass' ? (
                      <span className="text-[color:var(--tone-warn-on-tint)]">{option.label}</span>
                    ) : (
                      option.label
                    )}
                  </MenuItem>
                ))}
              </>
            )}
          </FooterMenu>
        </div>
      }
    />
  )
}

// The footer's permission chip names the preset, not the sentence behind it —
// the surface carries no explanatory copy (owner, 2026-08-04).
function permissionLabel(preset: SprintEngineCliPermissionPreset): string {
  if (preset === 'auto') return 'Auto in workspace'
  if (preset === 'bypass') return 'Bypass'
  return 'Default'
}

// The ⋯ contents: the axes and attachments that are set once rather than picked
// per spawn. Effort reads the CURRENT role's engine, so a level chosen here is
// the level the next spawn on that role actually launches with.
function MoreMenuItems({
  composer,
  workspaceRoot,
  worktreeAvailable,
  debugMode,
  onChangeDebugMode,
  close,
}: {
  composer: ReturnType<typeof useAgentComposer>
  workspaceRoot: string | null
  worktreeAvailable: boolean
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  close: () => void
}): JSX.Element {
  const cli = composer.cliForSelection(composer.selection)
  const levels = composer.agentCliOptions.find((option) => option.value === cli)?.reasoningSelection?.levels ?? []
  const reasoning = composer.reasoningForSelection(composer.selection, cli)
  return (
    <>
      {levels.length > 0 ? (
        <>
          <p className={MENU_GROUP_LABEL_CLASS}>Reasoning effort</p>
          <MenuItem
            selection="one-of"
            checked={!reasoning}
            trailing={<MenuTick shown={!reasoning} />}
            onClick={() => {
              composer.setEngineReasoning(composer.selection, cli, null)
              close()
            }}
          >
            Auto
          </MenuItem>
          {levels.map((level) => (
            <MenuItem
              key={level.id}
              selection="one-of"
              checked={reasoning === level.id}
              trailing={<MenuTick shown={reasoning === level.id} />}
              onClick={() => {
                composer.setEngineReasoning(composer.selection, cli, level.id)
                close()
              }}
            >
              {level.label ?? level.id}
            </MenuItem>
          ))}
        </>
      ) : null}
      {worktreeAvailable ? (
        <MenuItem
          checked={composer.worktreeName !== null}
          trailing={<MenuTick shown={composer.worktreeName !== null} />}
          onClick={() => composer.setWorktreeName(composer.worktreeName === null ? '' : null)}
        >
          Start in worktree
        </MenuItem>
      ) : null}
      {/* The same picker New chat has — install and add happen on pick, so a
          spawn from here starts with its skills and servers in place too. */}
      <SkillsAndMcpsPicker
        workspaceRoot={workspaceRoot}
        pluginId={composer.selection.kind === 'conversation' ? null : cli}
        skills={composer.skills}
        onSkillsChange={composer.setSkills}
        mcpServers={composer.mcpServers}
        onMcpServersChange={composer.setMcpServers}
        placement="top-start"
        renderTrigger={({ ref, triggerProps, togglePopover }) => {
          const picked = [...composer.skills.map((skill) => skill.name), ...composer.mcpServers.map((server) => server.name)]
          return (
            <button
              ref={ref}
              type="button"
              data-menu-item="true"
              tabIndex={-1}
              onClick={togglePopover}
              className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`}
              {...triggerProps}
            >
              <span className="min-w-0 flex-1 truncate">{picked.length > 0 ? picked.join(', ') : 'Skills & MCPs…'}</span>
              {picked.length > 0 ? <MenuTick shown /> : null}
            </button>
          )
        }}
      />
      <MenuItem
        checked={debugMode}
        trailing={<MenuTick shown={debugMode} />}
        onClick={() => onChangeDebugMode(!debugMode)}
      >
        Debug mode
      </MenuItem>
    </>
  )
}

// A footer control: a compact chip that opens a menu above it. The three read
// as one row — Role and ⋯ on the left, Permissions on the right — so their
// chrome is stated once, here, rather than three times inline.
function FooterMenu({
  ariaLabel,
  heading,
  label,
  tone,
  placement,
  tooltip,
  children,
}: {
  ariaLabel: string
  heading?: string
  label: string
  tone: 'quiet' | 'accent' | 'warn'
  placement: 'top-start' | 'top-end'
  tooltip?: string
  children: (close: () => void) => React.ReactNode
}): JSX.Element {
  const [open, setOpen] = React.useState(false)
  const surfaceRef = React.useRef<HTMLDivElement | null>(null)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement={placement}
      surfaceClassName={MENU_LIST_CLASS}
      renderTrigger={({ ref, triggerProps, togglePopover }) => {
        // The tooltip wraps the BUTTON, never the Popover: it attaches its
        // handlers by cloning its child, and a component that does not forward
        // them swallows the tooltip silently.
        const button = (
          <button
            ref={ref}
            type="button"
            aria-label={ariaLabel}
            onClick={togglePopover}
            className={[
              'interactive inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-meta',
              tone === 'warn'
                ? 'bg-[color:var(--tone-warn)]/12 text-[color:var(--tone-warn-on-tint)]'
                : tone === 'accent'
                  ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
                  : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
            {...triggerProps}
          >
            {label}
          </button>
        )
        return tooltip ? (
          <Tooltip content={tooltip} placement="top">
            {button}
          </Tooltip>
        ) : (
          button
        )
      }}
    >
      <div
        ref={surfaceRef}
        className="min-w-[168px]"
        onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}
      >
        {heading ? <p className={MENU_GROUP_LABEL_CLASS}>{heading}</p> : null}
        {children(() => setOpen(false))}
      </div>
    </Popover>
  )
}

// The trailing check on a chosen menu row. Reserved (rather than conditionally
// absent) so picking a row never reflows the menu under the pointer.
function MenuTick({ shown }: { shown: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={`size-icon-xs shrink-0 text-[color:var(--accent-primary)] ${shown ? '' : 'invisible'}`}
    >
      <path
        d="M2 5.2l2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The rail's terminal mark: a shell prompt, in the mono face the row's own name
// uses. CliIcon is reserved for CLI plugins, and a plain shell is not one.
function TerminalPromptGlyph(): JSX.Element {
  return (
    <span aria-hidden="true" className="font-mono text-micro font-semibold leading-none">
      ›_
    </span>
  )
}
