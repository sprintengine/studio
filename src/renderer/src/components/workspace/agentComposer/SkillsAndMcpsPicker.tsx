import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { AgentCli, McpServerConfig, WorkspaceSkill } from '../../../../../shared/electron-api'
import type { AgentMcpServer, AgentMcpServerStatus, SkillSource } from '../../../../../shared/skills'
import { STUDIO_MCP_SERVER_ID } from '../../../../../shared/product-identity'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { ensureSkillForAgent } from '../../../utils/skillInvocation'
import { CheckIcon } from '../../AppIcons'
import SprintEngineFrond from '../../brand/SprintEngineFrond'
import { sourceAvatarUrl } from '../globalSurface/extensions/catalogue/SourceAvatar'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../../settings/extensionsRoute'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import {
  ChipButton,
  Input,
  LinkButton,
  MENU_GROUP_LABEL_CLASS,
  MENU_ITEM_STACKED_CLASS,
  Popover,
  SegmentedControl,
  Spinner,
  StarGlyph,
  useWorkspaceSkills,
  type PopoverPlacement,
  type PopoverProps,
} from '../../ui'
import type { AgentComposerConnector } from './useAgentComposer'

// The composer's one picker for what a new agent starts with (browser-pane
// epic, child 7): the skills this workspace has, the skills it could have,
// and the MCP servers the launch CLI can reach — checkable rows in one
// searchable popover. Install and Add happen here, on pick, so the agent
// starts with everything in place rather than discovering a missing skill on
// its first turn (owner: "install them there and then before they create the
// agent").
//
// The search field keeps focus while ↑↓ move a highlight
// named by aria-activedescendant, ⏎ toggles, Escape closes (the Popover owns
// it), Home/End only while the field is empty — but the surface is NOT a
// combobox: rows toggle rather than commit, so the field is a search box
// naming a multi-select listbox through aria-controls, the shape the ruling
// gives its host. Rows commit on pointerdown-guarded click so the
// field never loses focus to a row.

type SkillRow = {
  key: string
  kind: 'skill'
  group: 'installed' | 'available'
  skill: WorkspaceSkill
}

type McpRow = {
  key: string
  kind: 'mcp'
  group: 'mcp'
  id: string
  name: string
  description?: string
  icon?: string
  /**
   * `included`: the app's own server, always on. `installed`: one of the app's
   * MCP settings, which a pick can add to the launch. `configured`: one the
   * CLI already has from its own config, its plugins or its account, which
   * reaches every chat on it without a pick.
   */
  state: 'installed' | 'included' | 'configured'
  config?: McpServerConfig
  /** Absent until a chat on this CLI in this folder has reported it. */
  status?: AgentMcpServerStatus
  error?: string
  toolCount?: number
}

export type PickerRow = SkillRow | McpRow

type PickerTab = 'skills' | 'mcp'

const GROUP_LABEL: Record<PickerRow['group'], string> = {
  installed: 'Skills in this workspace',
  available: 'Available to install',
  mcp: 'MCP servers',
}

/**
 * The MCP rows: the studio gateway as Included, then every server in the
 * app's settings (a disabled one too, so it can be switched back on from
 * here), then the servers only the CLI knows. `reported` is what the CLI's
 * capability answer says it is configured with, with the connection each one
 * last reported.
 *
 * A bundled catalogue of servers to Add sat behind these until the
 * third-party retirement (2026-09-08); an MCP server arrives inside a plugin
 * now, so this picker offers what the person already has and nothing else.
 */
export function buildMcpRows(
  installed: Record<string, McpServerConfig>,
  reported: readonly AgentMcpServer[] = [],
): McpRow[] {
  const report = new Map(reported.map((server) => [server.id, server]))
  const live = (id: string) => {
    const server = report.get(id)
    return {
      ...(server?.status ? { status: server.status } : {}),
      ...(server?.error ? { error: server.error } : {}),
      ...(server?.toolCount !== undefined ? { toolCount: server.toolCount } : {}),
    }
  }
  const rows: McpRow[] = []
  const seen = new Set<string>([STUDIO_MCP_SERVER_ID])
  rows.push({
    key: `mcp:${STUDIO_MCP_SERVER_ID}`,
    kind: 'mcp',
    group: 'mcp',
    id: STUDIO_MCP_SERVER_ID,
    name: STUDIO_MCP_SERVER_ID,
    description: 'The app’s own tools: backlog, automations, terminals, the pane’s browser.',
    state: 'included',
    ...live(STUDIO_MCP_SERVER_ID),
  })
  for (const config of Object.values(installed)) {
    if (seen.has(config.id)) continue
    seen.add(config.id)
    rows.push({
      key: `mcp:${config.id}`,
      kind: 'mcp',
      group: 'mcp',
      id: config.id,
      name: config.name,
      description: config.description,
      state: 'installed',
      config,
      // Switched off in the app's settings is the answer whatever a CLI said
      // before: no launch reaches it until it is switched back on.
      ...(config.enabled ? live(config.id) : { status: 'disabled' as const }),
    })
  }
  for (const server of reported) {
    if (seen.has(server.id)) continue
    seen.add(server.id)
    rows.push({
      key: `mcp:${server.id}`,
      kind: 'mcp',
      group: 'mcp',
      id: server.id,
      name: server.id,
      state: 'configured',
      ...live(server.id),
    })
  }
  return rows
}

const STATUS_WORD: Record<AgentMcpServerStatus, string> = {
  connected: 'Connected',
  pending: 'Connecting',
  'needs-auth': 'Needs sign-in',
  failed: 'Failed to connect',
  disabled: 'Disabled',
}

// MCP connection state is the one place the app draws a dot (owner ruling
// 2026-10-09): a server list is read down its column of names, and a coloured
// mark beside each is the fastest way to find the one that is not connected.
// The word is the dot's accessible name and tooltip, so nothing is told by
// colour alone; a disabled server's dot is hollow, which survives grayscale.
const STATUS_DOT: Record<AgentMcpServerStatus, string> = {
  connected: 'bg-[color:var(--tone-good)]',
  pending: 'bg-[color:var(--text-subtle)]',
  'needs-auth': 'bg-[color:var(--tone-warn)]',
  failed: 'bg-[color:var(--tone-error)]',
  disabled: 'border border-[color:var(--text-subtle)]',
}

function McpStatusDot({ status, error }: { status: AgentMcpServerStatus; error?: string }) {
  const label = error ? `${STATUS_WORD[status]}: ${error}` : STATUS_WORD[status]
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-mcp-status={status}
      className={`inline-block size-[7px] shrink-0 rounded-full ${STATUS_DOT[status]}`}
    />
  )
}

function rowMatches(row: PickerRow, normalized: string): boolean {
  if (!normalized) return true
  const haystack =
    row.kind === 'skill'
      ? [row.skill.id, row.skill.name, row.skill.description ?? '']
      : [row.id, row.name, row.description ?? '', row.config?.category ?? '']
  return haystack.some((text) => text.toLowerCase().includes(normalized))
}

export type SkillsAndMcpsPickerProps = {
  workspaceRoot: string | null
  /** The CLI that will launch; decides which skills are reachable and which MCP client to sync. */
  pluginId: AgentCli | null
  skills: WorkspaceSkill[]
  onSkillsChange: (next: WorkspaceSkill[]) => void
  mcpServers: AgentComposerConnector[]
  onMcpServersChange: (next: AgentComposerConnector[]) => void
  placement?: PopoverPlacement
  /** A custom trigger (a menu row, say); the default is the kit's chip. */
  renderTrigger?: PopoverProps['renderTrigger']
  includeMcps?: boolean
  /**
   * The CLI whose MCP servers to list beside the app's own, with the
   * connection each last reported. A chat passes its CLI here while keeping
   * `pluginId` null, because its skills come from the workspace inventory.
   * Defaults to `pluginId`.
   */
  mcpCli?: string | null
  /**
   * False where the servers cannot change any more (a running chat started
   * with its set): the rows say what is connected and pick nothing.
   */
  mcpPickable?: boolean
  /**
   * A chat on a paired machine: its skills and MCP servers are that
   * machine's, listed by it for the project there. A skill a pick would
   * install is installed over there when the chat takes it.
   */
  remote?: { connectionId: string; workspaceId: string }
  /**
   * Held by the host instead of the trigger (owner ruling 2026-10-04): the New
   * chat composer opens this from a row of its "+" menu and anchors it on the
   * "+" itself, so the trigger does not decide when it is open.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SkillsAndMcpsPicker({
  workspaceRoot,
  pluginId,
  skills,
  onSkillsChange,
  mcpServers,
  onMcpServersChange,
  placement = 'bottom-start',
  renderTrigger,
  includeMcps = true,
  mcpCli,
  mcpPickable = true,
  remote,
  open: heldOpen,
  onOpenChange,
}: SkillsAndMcpsPickerProps) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = heldOpen ?? ownOpen
  const setOpen = (next: boolean): void => {
    if (heldOpen === undefined) setOwnOpen(next)
    onOpenChange?.(next)
  }
  // A host that opens it from elsewhere gets the same fresh search the
  // trigger's own open starts with.
  const heldOpenNow = heldOpen === true
  useEffect(() => {
    if (!heldOpenNow) return
    setQuery('')
    setHighlight(0)
    setRowErrors({})
    setTab('skills')
  }, [heldOpenNow])
  const [tab, setTab] = useState<PickerTab>('skills')
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  // Skills installed from this popover, so their row moves group without a refetch.
  const [installedHere, setInstalledHere] = useState<Set<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const serversCli = mcpCli === undefined ? pluginId : mcpCli
  const localInventory = useWorkspaceSkills(remote ? null : workspaceRoot, pluginId, open && !remote)
  const localServers = useCliMcpServers(remote ? null : workspaceRoot, includeMcps ? serversCli : null, open)
  const remoteExtensions = useRemoteExtensions(remote ?? null, serversCli, open)
  const skillInventory = remote ? remoteExtensions : localInventory
  const reportedServers = remote ? remoteExtensions.servers : localServers
  const sources = useSkillSourcesById(open)
  const installedServers = useWorkspaceStore((s) => s.appSettings.mcp?.servers)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)

  const rows = useMemo<PickerRow[]>(() => {
    const skillRows: SkillRow[] = skillInventory.skills.map((skill) => {
      const installed = skill.installState !== 'available' || installedHere.has(skill.id)
      return {
        key: `skill:${skill.id}`,
        kind: 'skill',
        group: installed ? 'installed' : 'available',
        skill: installed && skill.installState === 'available' ? { ...skill, installState: 'installed' } : skill,
      }
    })
    const ordered =
      tab === 'mcp' && includeMcps
        ? // The app's own MCP settings are this machine's; a remote chat's
          // servers are the ones that machine reports.
          buildMcpRows(remote ? {} : (installedServers ?? {}), reportedServers)
        : [
            ...skillRows.filter((row) => row.group === 'installed'),
            ...skillRows.filter((row) => row.group === 'available'),
          ]
    const normalized = query.trim().toLowerCase()
    return ordered.filter((row) => rowMatches(row, normalized))
  }, [includeMcps, installedHere, installedServers, query, reportedServers, skillInventory.skills, tab])

  const groupsPresent = useMemo(() => new Set(rows.map((row) => row.group)), [rows])
  const actionable = useMemo(
    () => rows.filter((row) => row.kind === 'skill' || (mcpPickable && row.state === 'installed')),
    [mcpPickable, rows],
  )
  const highlighted = actionable[Math.min(highlight, Math.max(0, actionable.length - 1))] ?? null

  // The highlight is a moving mark the field owns; it must stay in view like
  // every other picker's (CommandPalette, CliModelPicker, Select).
  const highlightedKey = highlighted?.key ?? null
  useEffect(() => {
    if (!highlightedKey || !listRef.current) return
    // Keys are `skill:<id>` / `mcp:<id>`; ids are attribute-safe once quotes
    // are out (jsdom in tests has no `CSS.escape`).
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-picker-row="${highlightedKey.replace(/["\\]/g, '')}"]`,
    )
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedKey])

  const isChecked = useCallback(
    (row: PickerRow) =>
      row.kind === 'skill'
        ? skills.some((skill) => skill.id === row.skill.id)
        : mcpServers.some((server) => server.id === row.id),
    [mcpServers, skills],
  )

  const setError = (key: string, message: string | null) =>
    setRowErrors((current) => {
      const next = { ...current }
      if (message) next[key] = message
      else delete next[key]
      return next
    })

  const toggleSkill = async (row: SkillRow) => {
    if (isChecked(row)) {
      onSkillsChange(skills.filter((skill) => skill.id !== row.skill.id))
      return
    }
    if (row.group === 'available' && remote) {
      onSkillsChange([...skills, row.skill])
      return
    }
    if (row.group === 'available') {
      if (!workspaceRoot) {
        setError(row.key, 'Open a project folder to install skills.')
        return
      }
      setBusyKey(row.key)
      setError(row.key, null)
      const result = await ensureSkillForAgent({ workspaceRoot, skill: row.skill })
      setBusyKey(null)
      if (!result.ok) {
        setError(row.key, result.message)
        return
      }
      setInstalledHere((current) => new Set(current).add(row.skill.id))
      onSkillsChange([...skills, { ...row.skill, installState: 'installed' }])
      return
    }
    onSkillsChange([...skills, row.skill])
  }

  // An MCP pick is real: the server lands in the app's MCP settings (enabled,
  // reaching the launch CLI) and the workspace's CLI config is written, before
  // the agent exists. A server whose credentials are unset is refused on the
  // row rather than added blind.
  const toggleMcp = async (row: McpRow) => {
    if (row.state !== 'installed' || !mcpPickable) return
    if (isChecked(row)) {
      onMcpServersChange(mcpServers.filter((server) => server.id !== row.id))
      return
    }
    const pick: AgentComposerConnector = { id: row.id, name: row.name, ...(row.icon ? { icon: row.icon } : {}) }
    const base = row.config
    if (!base) return
    const needsClient = pluginId !== null && !base.clients.includes(pluginId)
    // A server switched off in the app's settings is switched back on by the
    // pick, through the same write and sync a missing client takes.
    if (!needsClient && base.enabled) {
      onMcpServersChange([...mcpServers, pick])
      return
    }
    if (!workspaceRoot) {
      setError(row.key, 'Open a project folder to add MCP servers.')
      return
    }
    setBusyKey(row.key)
    setError(row.key, null)
    // The app's settings are written first so the sync reads them; a sync
    // that fails puts them back, so a refused pick leaves no server enabled
    // behind it for every other workspace to inherit.
    const previous = useWorkspaceStore.getState().appSettings.mcp?.servers?.[row.id]
    try {
      upsertMcpServer({
        ...base,
        enabled: true,
        clients: needsClient && pluginId ? [...base.clients, pluginId] : base.clients,
      })
      const settings = useWorkspaceStore.getState().appSettings.mcp
      if (!settings) throw new Error('MCP settings are unavailable.')
      if (!settings.syncEnabled) throw new Error('MCP sync is turned off in Settings; turn it on to add servers.')
      // The sync is scoped to the CLI that will launch; the default client
      // list (codex + claude-code) would silently skip any other CLI.
      const result = await window.api.mcpSync({ workspaceRoot, settings, ...(pluginId ? { clients: [pluginId] } : {}) })
      if (!result.ok) throw new Error(result.message)
      // A sync that wrote no file for this CLI, or wrote one without this
      // server in it, did not make the pick real.
      const written = result.targets.some((target) => target.serverIds.includes(row.id))
      if (!written) throw new Error('Nothing was written to the workspace config for this CLI.')
      onMcpServersChange([...mcpServers, pick])
    } catch (error) {
      if (previous) upsertMcpServer(previous)
      else removeMcpServer(row.id)
      setError(row.key, error instanceof Error ? error.message : 'Unable to add the MCP server.')
    } finally {
      setBusyKey(null)
    }
  }

  const toggle = (row: PickerRow) => {
    if (busyKey) return
    if (row.kind === 'skill') void toggleSkill(row)
    else void toggleMcp(row)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((current) => Math.max(0, Math.min(actionable.length - 1, current + delta)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (highlighted) toggle(highlighted)
    } else if ((event.key === 'Home' || event.key === 'End') && query === '') {
      // The caret has no claim on these while the field is empty.
      event.preventDefault()
      event.stopPropagation()
      setHighlight(event.key === 'Home' ? 0 : Math.max(0, actionable.length - 1))
    }
  }

  const pickedCount = skills.length + mcpServers.length
  const rowDomId = (row: PickerRow) => `${listId}-${row.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery('')
          setHighlight(0)
          setRowErrors({})
        }
        setOpen(next)
      }}
      ariaLabel={includeMcps ? 'Skills and MCPs' : 'Skills'}
      popupRole="dialog"
      placement={placement}
      renderTrigger={
        renderTrigger ??
        (({ ref, triggerProps, togglePopover }) => (
          // The kit's chip, which is what both hosts were passing a chrome
          // string to draw: the `triggerClassName` escape hatch is gone with
          // it, because a trigger the kit can draw does not need one.
          <ChipButton ref={ref} variant="raised" onClick={togglePopover} {...triggerProps}>
            <StarGlyph filled={false} stroked className="icon-xs" />
            {includeMcps ? 'Skills & MCPs' : 'Skills'}
            {pickedCount > 0 ? <span className="text-[color:var(--text-subtle)]">· {pickedCount}</span> : null}
          </ChipButton>
        ))
      }
    >
      <div className="flex max-h-[420px] w-[360px] flex-col overflow-hidden">
        {includeMcps ? (
          <div className="border-b border-[color:var(--border-subtle)] p-1.5">
            <SegmentedControl
              ariaLabel="Show"
              size="sm"
              items={[
                { value: 'skills', label: 'Skills' },
                { value: 'mcp', label: 'MCP servers' },
              ]}
              value={tab}
              onChange={(next: PickerTab) => {
                setTab(next)
                setHighlight(0)
                inputRef.current?.focus()
              }}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-1 border-b border-[color:var(--border-subtle)] p-1 pl-2.5">
          <svg
            className="icon-xs shrink-0 text-[color:var(--text-disabled)]"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {/* `seamless`: the bordered row around it is the box, so the field
              spends no border, ground, radius or ring of its own. */}
          <Input
            ref={inputRef}
            variant="seamless"
            fullWidth={false}
            autoFocus
            type="search"
            aria-controls={listId}
            aria-activedescendant={highlighted ? rowDomId(highlighted) : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={tab === 'mcp' ? 'Search MCP servers…' : 'Search skills…'}
            aria-label={tab === 'mcp' ? 'Search MCP servers' : 'Search skills'}
            className="min-w-0 flex-1 px-1 py-1 text-body"
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={includeMcps ? 'Skills and MCP servers' : 'Skills'}
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {tab === 'skills' && skillInventory.loading && rows.length === 0 ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
              <Spinner />
              Loading…
            </div>
          ) : null}
          {tab === 'skills' && skillInventory.error ? (
            <div className="px-2.5 py-2 text-meta text-[color:var(--tone-error)]" role="status">
              {skillInventory.error}
            </div>
          ) : null}
          {rows.length === 0 && (tab === 'mcp' || (!skillInventory.loading && !skillInventory.error)) ? (
            <div className="px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
              {query.trim()
                ? `Nothing matches “${query.trim()}”`
                : tab === 'mcp'
                  ? 'No MCP servers yet'
                  : 'No skills yet'}
            </div>
          ) : null}
          {(['installed', 'available', 'mcp'] as const).map((group) => {
            const groupRows = rows.filter((row) => row.group === group)
            if (groupRows.length === 0) return null
            return (
              <div key={group} role="group" aria-label={GROUP_LABEL[group]}>
                {groupsPresent.size > 1 ? (
                  <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1.5`} aria-hidden="true">
                    {GROUP_LABEL[group]}
                  </div>
                ) : null}
                {groupRows.map((row) => (
                  <PickerRowView
                    key={row.key}
                    id={rowDomId(row)}
                    row={row}
                    checked={isChecked(row)}
                    pickable={row.kind === 'skill' || (mcpPickable && row.state === 'installed')}
                    sourceRepo={
                      row.kind !== 'skill'
                        ? undefined
                        : row.skill.sourceRepo
                          ? { kind: 'github', repo: row.skill.sourceRepo }
                          : row.skill.sourceId
                            ? sources.get(row.skill.sourceId)
                            : undefined
                    }
                    highlighted={highlighted?.key === row.key}
                    busy={busyKey === row.key}
                    error={rowErrors[row.key] ?? null}
                    onToggle={() => toggle(row)}
                    onHover={() => {
                      const index = actionable.findIndex((candidate) => candidate.key === row.key)
                      if (index >= 0) setHighlight(index)
                    }}
                  />
                ))}
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-end border-t border-[color:var(--border-subtle)] px-2.5 py-1.5">
          {/* The kit's text link: accent ink, underlined on hover, and no box
              at all — an action set in a footer line, which is the whole reason
              this was four utilities cancelling a button. */}
          <LinkButton
            onClick={() => {
              setOpen(false)
              openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })
            }}
            className="text-micro"
          >
            Browse extensions →
          </LinkButton>
        </div>
      </div>
    </Popover>
  )
}

function PickerRowView({
  id,
  row,
  checked,
  pickable,
  sourceRepo,
  highlighted,
  busy,
  error,
  onToggle,
  onHover,
}: {
  id: string
  row: PickerRow
  checked: boolean
  pickable: boolean
  sourceRepo?: Pick<SkillSource, 'kind' | 'repo'>
  highlighted: boolean
  busy: boolean
  error: string | null
  onToggle: () => void
  onHover: () => void
}) {
  const name = row.kind === 'skill' ? row.skill.name : row.name
  const description = row.kind === 'skill' ? row.skill.description : row.description
  const failure = row.kind === 'mcp' && row.status === 'failed' ? row.error : undefined
  const trailing = busy ? (
    <Spinner size={12} label={row.kind === 'skill' ? 'Installing' : 'Adding'} />
  ) : checked ? (
    <CheckIcon className="icon-xs text-[color:var(--accent-primary)]" />
  ) : row.kind === 'skill' && row.group === 'available' ? (
    'Install'
  ) : null
  return (
    <div
      id={id}
      role="option"
      aria-selected={checked}
      aria-disabled={!pickable || undefined}
      data-picker-row={row.key}
      // pointerdown is where the field would lose focus; the click still toggles.
      onPointerDown={(event) => event.preventDefault()}
      onClick={pickable ? onToggle : undefined}
      onMouseMove={pickable ? onHover : undefined}
      className={`${MENU_ITEM_STACKED_CLASS} ${pickable ? 'cursor-pointer' : 'cursor-default'} ${
        highlighted ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
      }`}
    >
      <span className="mt-0.5 flex shrink-0 items-center justify-center">
        <RowIcon row={row} sourceRepo={sourceRepo} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{name}</span>
          {row.kind === 'mcp' && row.status ? <McpStatusDot status={row.status} error={row.error} /> : null}
          {row.kind === 'mcp' && row.status === 'connected' && row.toolCount !== undefined ? (
            <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">
              {row.toolCount === 1 ? '1 tool' : `${row.toolCount} tools`}
            </span>
          ) : null}
        </span>
        {description ? (
          <span className="block truncate text-meta text-[color:var(--text-muted)]">{description}</span>
        ) : null}
        {failure ? <span className="block truncate text-meta text-[color:var(--tone-error)]">{failure}</span> : null}
        {error ? (
          <span className="block text-meta text-[color:var(--tone-error)]" role="alert">
            {row.kind === 'skill' ? 'Couldn’t install' : 'Couldn’t add'} — {error}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="mt-0.5 shrink-0 text-micro text-[color:var(--text-subtle)]">{trailing}</span> : null}
    </div>
  )
}

const ROW_ICON_SIZE = 20

// Where the row came from, by its face: the app's own frond on what the app
// ships, the source owner's avatar on a skill installed from a source, the
// service's logo on an MCP server, and its letters when there is nothing else.
function RowIcon({ row, sourceRepo }: { row: PickerRow; sourceRepo?: Pick<SkillSource, 'kind' | 'repo'> }) {
  if (row.kind === 'mcp') {
    if (row.state === 'included')
      return <ExtensionIcon name={row.name} size={ROW_ICON_SIZE} mark={<SprintEngineFrond className="icon-xs" />} />
    return <ExtensionIcon slug={mcpIconSlug(row.id)} name={row.name} icon={row.icon} size={ROW_ICON_SIZE} />
  }
  if (row.skill.source === 'builtin')
    return <ExtensionIcon name={row.skill.name} size={ROW_ICON_SIZE} mark={<SprintEngineFrond className="icon-xs" />} />
  const avatar = sourceRepo ? sourceAvatarUrl(sourceRepo, ROW_ICON_SIZE) : null
  return (
    <ExtensionIcon name={row.skill.name} size={ROW_ICON_SIZE} {...(avatar ? { icon: avatar, iconPlated: true } : {})} />
  )
}

/**
 * The servers the CLI itself is configured with, and what it last said about
 * each: read on every open, so a server that connected or failed since shows.
 */
function useCliMcpServers(workspaceRoot: string | null, cli: string | null, active: boolean): AgentMcpServer[] {
  const [servers, setServers] = useState<AgentMcpServer[]>([])
  useEffect(() => {
    if (!active || !workspaceRoot || !cli) return
    let cancelled = false
    window.api
      .agentCapabilities({ workspaceRoot, pluginId: cli })
      .then((answer) => {
        if (!cancelled) setServers(answer.ok ? (answer.servers ?? []) : [])
      })
      .catch(() => {
        if (!cancelled) setServers([])
      })
    return () => {
      cancelled = true
    }
  }, [active, cli, workspaceRoot])
  return servers
}

/**
 * A paired machine's skills and MCP servers for one of its projects, read on
 * every open as the local ones are.
 */
function useRemoteExtensions(
  remote: { connectionId: string; workspaceId: string } | null,
  cli: string | null,
  active: boolean,
): { skills: WorkspaceSkill[]; servers: AgentMcpServer[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{
    skills: WorkspaceSkill[]
    servers: AgentMcpServer[]
    loading: boolean
    error: string | null
  }>({ skills: [], servers: [], loading: false, error: null })
  const connectionId = remote?.connectionId ?? null
  const workspaceId = remote?.workspaceId ?? null
  useEffect(() => {
    if (!active || !connectionId || !workspaceId) return
    let cancelled = false
    setState((current) => ({ ...current, loading: true, error: null }))
    window.api
      .meshWorkspaceExtensions({ connectionId, workspaceId, ...(cli ? { cli } : {}) })
      .then((answer) => {
        if (cancelled) return
        setState(
          answer.ok
            ? { skills: answer.extensions.skills, servers: answer.extensions.servers, loading: false, error: null }
            : { skills: [], servers: [], loading: false, error: answer.message },
        )
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            skills: [],
            servers: [],
            loading: false,
            error: error instanceof Error ? error.message : 'Could not list that machine’s skills.',
          })
      })
    return () => {
      cancelled = true
    }
  }, [active, cli, connectionId, workspaceId])
  return state
}

/** The skill sources by id, for the owner's face on a skill one installed. */
function useSkillSourcesById(active: boolean): ReadonlyMap<string, SkillSource> {
  const [sources, setSources] = useState<ReadonlyMap<string, SkillSource>>(() => new Map())
  useEffect(() => {
    if (!active) return
    let cancelled = false
    Promise.resolve(window.api.skillsListSources?.())
      .then((answer) => {
        if (!cancelled && answer?.ok) setSources(new Map(answer.sources.map((source) => [source.id, source])))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [active])
  return sources
}
