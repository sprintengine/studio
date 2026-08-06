import React, { useEffect, useMemo, useState } from 'react'
import type { McpCatalogServer } from '../../../../../shared/electron-api'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { launchableConnectors } from '../../panels/ConnectorsPanel/connectorsFacets'
import { McpBrandIcon, mcpIconSlug } from '../../settings/McpCatalog'
import { FOCUS_RING_CLASS, MENU_ITEM_STACKED_CLASS, Popover, Spinner, TruncatedText, type PopoverPlacement, type PopoverProps } from '../../ui'

// The composer's "+ Connector" picker: the same launchable population as the
// Connectors surface's Ready-to-launch rail (skill-paired catalog entries plus
// installed+enabled servers), searchable, keyboard-operable from its own input.
// Picking only attaches — the spawn resolves the connector and mints its
// isolated worktree on confirm, exactly like launchConnectorChat.

type ConnectorInventoryState = {
  connectors: McpCatalogServer[]
  loading: boolean
  error: string | null
}

// Loads the merged launchable population when `active` flips true (each open
// refetches — installs/enables elsewhere must show up on the next open). A
// failed catalog read still surfaces the installed servers, which launch
// without the catalog; only a total absence reports the failure.
function useLaunchableConnectors(active: boolean): ConnectorInventoryState {
  const installedServers = useWorkspaceStore((s) => s.appSettings.mcp?.servers)
  const [state, setState] = useState<ConnectorInventoryState>({
    connectors: [],
    loading: false,
    error: null,
  })
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    window.api
      .mcpListCatalog()
      .then((result) => {
        if (cancelled) return
        const connectors = launchableConnectors(result.ok ? result.servers : [], installedServers)
        if (!result.ok && connectors.length === 0) {
          setState({ connectors: [], loading: false, error: result.message })
        } else {
          setState({ connectors, loading: false, error: null })
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const connectors = launchableConnectors([], installedServers)
        setState({
          connectors,
          loading: false,
          error: connectors.length === 0
            ? error instanceof Error
              ? error.message
              : 'Unable to load the connector catalog.'
            : null,
        })
      })
    return () => {
      cancelled = true
    }
  }, [active, installedServers])
  return state
}

function matchesQuery(server: McpCatalogServer, normalized: string): boolean {
  if (!normalized) return true
  return (
    server.id.toLowerCase().includes(normalized)
    || server.name.toLowerCase().includes(normalized)
    || (server.description?.toLowerCase().includes(normalized) ?? false)
    || (server.category?.toLowerCase().includes(normalized) ?? false)
  )
}

function ConnectorRow({
  server,
  active,
  onPick,
  onHover,
}: {
  server: McpCatalogServer
  active: boolean
  onPick: (server: McpCatalogServer) => void
  onHover: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-connector-row={server.id}
      onClick={() => onPick(server)}
      onMouseMove={onHover}
      // `active` is the keyboard cursor of a MENU, not a selection: nothing here
      // persists past the pick, and the pointer moves the cursor as it travels.
      // So it is the menu system's one highlight — `--bg-hover`, the same fill
      // hovering paints (ui/menuClasses, ui/Select) — rather than the third
      // token `--bg-active` it used to spend, which matched neither the hover
      // state beside it nor the selection fill every persistent list uses.
      className={`${MENU_ITEM_STACKED_CLASS} ${
        active
          ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={22} />
      <span className="min-w-0 flex-1">
        <TruncatedText as="span" text={server.name} className="block text-body font-medium text-[color:var(--text-strong)]" />
        {server.description ? (
          <TruncatedText as="span" text={server.description} className="block text-meta text-[color:var(--text-muted)]" />
        ) : null}
      </span>
    </button>
  )
}

export type ConnectorPickerPopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (server: McpCatalogServer) => void
  placement?: PopoverPlacement
  renderTrigger: PopoverProps['renderTrigger']
}

export function ConnectorPickerPopover({
  open,
  onOpenChange,
  onPick,
  placement = 'top-start',
  renderTrigger,
}: ConnectorPickerPopoverProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inventory = useLaunchableConnectors(open)
  const matched = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return inventory.connectors.filter((server) => matchesQuery(server, normalized))
  }, [inventory.connectors, query])

  const clampedActive = Math.min(activeIndex, Math.max(0, matched.length - 1))
  const pick = (server: McpCatalogServer) => {
    onOpenChange(false)
    onPick(server)
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(Math.min(clampedActive + 1, matched.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(Math.max(clampedActive - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const server = matched[clampedActive]
      if (server) pick(server)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery('')
          setActiveIndex(0)
        }
        onOpenChange(next)
      }}
      ariaLabel="Attach a connector"
      popupRole="menu"
      placement={placement}
      renderTrigger={renderTrigger}
    >
      <div className="flex max-h-[400px] w-[340px] flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-[color:var(--border-subtle)] p-1 pl-2.5">
          <svg className="icon-xs shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search connectors…"
            aria-label="Search connectors"
            className={`min-w-0 flex-1 bg-transparent px-1 py-1 text-body text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
          />
        </div>
        {inventory.loading && matched.length === 0 ? (
          <div className="flex items-center gap-2 px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
            <Spinner />
            Loading connectors…
          </div>
        ) : inventory.error ? (
          <div className="px-2.5 py-3 text-meta text-[color:var(--tone-error)]" role="status">
            {inventory.error}
          </div>
        ) : matched.length === 0 ? (
          <div className="px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
            {query.trim() ? `No connectors match “${query.trim()}”` : 'No launchable connectors yet'}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {matched.map((server, index) => (
              <ConnectorRow
                key={server.id}
                server={server}
                active={index === clampedActive}
                onPick={pick}
                onHover={() => setActiveIndex(index)}
              />
            ))}
          </div>
        )}
        <div className="flex items-center border-t border-[color:var(--border-subtle)] px-2.5 py-1.5">
          <span className="text-micro text-[color:var(--text-subtle)]">
            ↑↓ choose · ⏎ attach · runs in an isolated worktree
          </span>
        </div>
      </div>
    </Popover>
  )
}
