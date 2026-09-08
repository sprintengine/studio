import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { AgentCli, McpCatalogServer, McpServerConfig, WorkspaceSkill } from '../../../../../shared/electron-api'
import { mcpServerFromCatalog } from '../../../../../shared/connector-launch'
import { STUDIO_MCP_SERVER_ID } from '../../../../../shared/product-identity'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { ensureSkillForAgent } from '../../../utils/skillInvocation'
import { CheckIcon } from '../../AppIcons'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../../settings/extensionsRoute'
import { McpBrandIcon, mcpIconSlug } from '../../settings/McpCatalog'
import {
  FOCUS_RING_CLASS,
  MENU_GROUP_LABEL_CLASS,
  MENU_ITEM_STACKED_CLASS,
  Popover,
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
// Keyboard model follows the combobox ruling (design-system/components/
// combobox) for its keys — the search field keeps focus, ↑↓ move a highlight
// named by aria-activedescendant, ⏎ toggles, Escape closes (the Popover owns
// it), Home/End only while the field is empty — but the surface is NOT a
// combobox: rows toggle rather than commit, so the field is a search box
// naming a multi-select listbox through aria-controls, the shape the ruling
// gives NewSprintDialog. Rows commit on pointerdown-guarded click so the
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
  /** `stdio · workspace`, `socket · always on`: transport and scope, the row's fine print. */
  meta: string
  state: 'installed' | 'catalog' | 'included'
  catalog?: McpCatalogServer
  config?: McpServerConfig
}

export type PickerRow = SkillRow | McpRow

const GROUP_LABEL: Record<PickerRow['group'], string> = {
  installed: 'Skills in this workspace',
  available: 'Available to install',
  mcp: 'MCP servers',
}

const SKILL_SOURCE_LABEL: Record<WorkspaceSkill['source'], string> = {
  builtin: 'Built-in',
  custom: 'Custom',
  plugin: 'Plugin',
}

type McpInventory = { catalog: McpCatalogServer[]; loading: boolean; error: string | null }

// The catalog is read once per open (an install elsewhere shows on the next
// open); the installed set is live store state.
function useMcpCatalog(active: boolean): McpInventory {
  const [state, setState] = useState<McpInventory>({ catalog: [], loading: false, error: null })
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    window.api
      .mcpListCatalog()
      .then((result) => {
        if (cancelled) return
        setState(result.ok ? { catalog: result.servers, loading: false, error: null } : { catalog: [], loading: false, error: result.message })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({ catalog: [], loading: false, error: error instanceof Error ? error.message : 'Unable to load the MCP catalog.' })
      })
    return () => {
      cancelled = true
    }
  }, [active])
  return state
}

function transportLabel(transport: McpServerConfig['transport'] | undefined): string {
  return transport === 'http' || transport === 'sse' ? 'http' : 'stdio'
}

/** The MCP rows: installed servers first, the catalog's rest as Add rows, the studio gateway as Included. */
export function buildMcpRows(catalog: McpCatalogServer[], installed: Record<string, McpServerConfig>): McpRow[] {
  const byId = new Map(catalog.map((server) => [server.id, server]))
  const rows: McpRow[] = []
  const seen = new Set<string>([STUDIO_MCP_SERVER_ID])
  rows.push({
    key: `mcp:${STUDIO_MCP_SERVER_ID}`,
    kind: 'mcp',
    group: 'mcp',
    id: STUDIO_MCP_SERVER_ID,
    name: STUDIO_MCP_SERVER_ID,
    description: 'The app’s own tools: backlog, sprints, terminals, the pane’s browser.',
    meta: 'socket · always on',
    state: 'included',
  })
  for (const config of Object.values(installed)) {
    if (!config.enabled || seen.has(config.id)) continue
    seen.add(config.id)
    const entry = byId.get(config.id)
    rows.push({
      key: `mcp:${config.id}`,
      kind: 'mcp',
      group: 'mcp',
      id: config.id,
      name: entry?.name ?? config.name,
      description: entry?.description ?? config.description,
      icon: entry?.icon,
      meta: `${transportLabel(config.transport)} · ${config.scope}`,
      state: 'installed',
      catalog: entry,
      config,
    })
  }
  for (const server of catalog) {
    if (seen.has(server.id)) continue
    seen.add(server.id)
    rows.push({
      key: `mcp:${server.id}`,
      kind: 'mcp',
      group: 'mcp',
      id: server.id,
      name: server.name,
      description: server.description,
      icon: server.icon,
      meta: 'catalog',
      state: 'catalog',
      catalog: server,
    })
  }
  return rows
}

function rowMatches(row: PickerRow, normalized: string): boolean {
  if (!normalized) return true
  const haystack =
    row.kind === 'skill'
      ? [row.skill.id, row.skill.name, row.skill.description ?? '']
      : [row.id, row.name, row.description ?? '', row.catalog?.category ?? '']
  return haystack.some((text) => text.toLowerCase().includes(normalized))
}

/** A catalog server whose credentials are not set cannot be added silently. */
function missingCredentials(server: McpCatalogServer): string[] {
  return (server.envVarNames ?? []).filter((name) => !server.env?.[name])
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
  triggerClassName?: string
  /** A custom trigger (a menu row, say); the default is the ghost chip. */
  renderTrigger?: PopoverProps['renderTrigger']
}

export function SkillsAndMcpsPicker({
  workspaceRoot,
  pluginId,
  skills,
  onSkillsChange,
  mcpServers,
  onMcpServersChange,
  placement = 'bottom-start',
  triggerClassName = '',
  renderTrigger,
}: SkillsAndMcpsPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  // Skills installed from this popover, so their row moves group without a refetch.
  const [installedHere, setInstalledHere] = useState<Set<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const skillInventory = useWorkspaceSkills(workspaceRoot, pluginId, open)
  const mcpCatalog = useMcpCatalog(open)
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
    const ordered = [
      ...skillRows.filter((row) => row.group === 'installed'),
      ...skillRows.filter((row) => row.group === 'available'),
      ...buildMcpRows(mcpCatalog.catalog, installedServers ?? {}),
    ]
    const normalized = query.trim().toLowerCase()
    return ordered.filter((row) => rowMatches(row, normalized))
  }, [installedHere, installedServers, mcpCatalog.catalog, query, skillInventory.skills])

  const groupsPresent = useMemo(() => new Set(rows.map((row) => row.group)), [rows])
  const actionable = useMemo(() => rows.filter((row) => !(row.kind === 'mcp' && row.state === 'included')), [rows])
  const highlighted = actionable[Math.min(highlight, Math.max(0, actionable.length - 1))] ?? null

  // The highlight is a moving mark the field owns; it must stay in view like
  // every other picker's (CommandPalette, CliModelPicker, Select).
  const highlightedKey = highlighted?.key ?? null
  useEffect(() => {
    if (!highlightedKey || !listRef.current) return
    // Keys are `skill:<id>` / `mcp:<id>`; ids are attribute-safe once quotes
    // are out (jsdom in tests has no `CSS.escape`).
    const row = listRef.current.querySelector<HTMLElement>(`[data-picker-row="${highlightedKey.replace(/["\\]/g, '')}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedKey])

  const isChecked = useCallback(
    (row: PickerRow) =>
      row.kind === 'skill' ? skills.some((skill) => skill.id === row.skill.id) : mcpServers.some((server) => server.id === row.id),
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
    if (row.state === 'included') return
    if (isChecked(row)) {
      onMcpServersChange(mcpServers.filter((server) => server.id !== row.id))
      return
    }
    const pick: AgentComposerConnector = { id: row.id, name: row.name, ...(row.icon ? { icon: row.icon } : {}) }
    const base = row.config ?? (row.catalog ? mcpServerFromCatalog(row.catalog) : null)
    if (!base) return
    if (row.state === 'catalog' && row.catalog) {
      const missing = missingCredentials(row.catalog)
      if (missing.length > 0) {
        setError(row.key, `Needs ${missing.join(', ')} — set it under Manage extensions first.`)
        return
      }
    }
    const needsClient = pluginId !== null && !base.clients.includes(pluginId)
    if (row.state === 'installed' && !needsClient) {
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
      ariaLabel="Skills and MCPs"
      popupRole="dialog"
      placement={placement}
      renderTrigger={
        renderTrigger
        ?? (({ ref, triggerProps, togglePopover }) => (
          <button ref={ref} type="button" onClick={togglePopover} className={triggerClassName} {...triggerProps}>
            <StarGlyph filled={false} className="icon-xs" />
            Skills &amp; MCPs
            {pickedCount > 0 ? <span className="text-[color:var(--text-subtle)]">· {pickedCount}</span> : null}
          </button>
        ))
      }
    >
      <div className="flex max-h-[420px] w-[360px] flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-[color:var(--border-subtle)] p-1 pl-2.5">
          <svg className="icon-xs shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
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
            placeholder="Search skills and MCPs…"
            aria-label="Search skills and MCPs"
            className={`min-w-0 flex-1 bg-transparent px-1 py-1 text-body text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-multiselectable="true" aria-label="Skills and MCP servers" className="min-h-0 flex-1 overflow-y-auto py-1">
          {(skillInventory.loading || mcpCatalog.loading) && rows.length === 0 ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
              <Spinner />
              Loading…
            </div>
          ) : null}
          {skillInventory.error ? (
            <div className="px-2.5 py-2 text-meta text-[color:var(--tone-error)]" role="status">
              {skillInventory.error}
            </div>
          ) : null}
          {mcpCatalog.error ? (
            <div className="px-2.5 py-2 text-meta text-[color:var(--tone-error)]" role="status">
              {mcpCatalog.error}
            </div>
          ) : null}
          {!skillInventory.loading && !mcpCatalog.loading && rows.length === 0 && !skillInventory.error && !mcpCatalog.error ? (
            <div className="px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
              {query.trim() ? `Nothing matches “${query.trim()}”` : 'No skills or MCP servers yet'}
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
        <div className="flex items-center justify-between border-t border-[color:var(--border-subtle)] px-2.5 py-1.5">
          <span className="text-micro text-[color:var(--text-subtle)]">↑↓ choose · ⏎ toggle · esc close</span>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })
            }}
            className={`interactive text-micro text-[color:var(--accent-primary)] hover:underline ${FOCUS_RING_CLASS}`}
          >
            Manage extensions →
          </button>
        </div>
      </div>
    </Popover>
  )
}

function PickerRowView({
  id,
  row,
  checked,
  highlighted,
  busy,
  error,
  onToggle,
  onHover,
}: {
  id: string
  row: PickerRow
  checked: boolean
  highlighted: boolean
  busy: boolean
  error: string | null
  onToggle: () => void
  onHover: () => void
}) {
  const included = row.kind === 'mcp' && row.state === 'included'
  const name = row.kind === 'skill' ? row.skill.name : row.name
  const description = row.kind === 'skill' ? row.skill.description : row.description
  const trailing = busy ? (
    <Spinner size={12} label={row.kind === 'skill' ? 'Installing' : 'Adding'} />
  ) : included ? (
    'Included'
  ) : row.kind === 'skill' ? (
    row.group === 'available' ? 'Install' : SKILL_SOURCE_LABEL[row.skill.source]
  ) : row.state === 'catalog' ? (
    'Add'
  ) : null
  return (
    <div
      id={id}
      role="option"
      aria-selected={checked}
      aria-disabled={included || undefined}
      data-picker-row={row.key}
      // pointerdown is where the field would lose focus; the click still toggles.
      onPointerDown={(event) => event.preventDefault()}
      onClick={included ? undefined : onToggle}
      onMouseMove={included ? undefined : onHover}
      className={`${MENU_ITEM_STACKED_CLASS} ${included ? 'cursor-default' : 'cursor-pointer'} ${
        highlighted ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
      }`}
    >
      <span className="mt-0.5 flex size-icon-sm shrink-0 items-center justify-center">
        {checked ? (
          <CheckIcon className="icon-xs text-[color:var(--accent-primary)]" />
        ) : row.kind === 'skill' ? (
          <StarGlyph filled={false} className="icon-xs text-[color:var(--text-subtle)]" />
        ) : (
          <McpBrandIcon slug={mcpIconSlug(row.id)} name={row.name} icon={row.icon} size={16} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-[color:var(--text-strong)]">{name}</span>
        {description ? <span className="block truncate text-meta text-[color:var(--text-muted)]">{description}</span> : null}
        {row.kind === 'mcp' ? <span className="block text-micro text-[color:var(--text-subtle)]">{row.meta}</span> : null}
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
