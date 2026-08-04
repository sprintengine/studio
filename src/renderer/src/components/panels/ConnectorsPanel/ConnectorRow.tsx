// ConnectorRow — the one list row the whole Connectors surface renders: Browse
// (catalog + registry via ConnectorEntryRow) and the Installed view (via the
// generic ConnectorRow) share it so the surface reads as one system. Icon chip ·
// name + provides chips · one-line summary (or status line) · right-aligned
// actions. Transport and other plumbing stay off the row face — they belong to
// the detail panels.

import React from 'react'

import { GhostButton, PrimaryButton, TruncatedText } from '../../ui'
import { McpBrandIcon, mcpIconSlug } from '../../settings/McpCatalog'
import { PluginIcon, resolveIconUrl } from '../../settings/BrowseStorefront'
import type { ConnectorEntry } from './connectorsFacets'

// The one section-heading treatment for the whole Connectors surface: muted
// label · hairline · count.
export function ConnectorSectionHeading({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-body font-medium text-[color:var(--text-muted)]">{label}</span>
      <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
      {typeof count === 'number' ? (
        <span className="tabular-nums font-mono text-meta text-[color:var(--text-subtle)]">{count}</span>
      ) : null}
    </div>
  )
}

// Small neutral text chip ("MCP server", "Skill pack", "Bundled", "http", …) —
// plain text on the active-background token, never a mono string.
export function ConnectorChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-[color:var(--bg-active)] px-1.5 py-0.5 text-meta leading-3 text-[color:var(--text-subtle)]">
      {label}
    </span>
  )
}

export function ConnectorRow({
  icon,
  name,
  summary,
  chips = [],
  status,
  actions,
  selected = false,
  onOpen,
  variant = 'card',
}: {
  icon: React.ReactNode
  name: string
  summary?: string
  chips?: string[]
  // Optional status line (Installed rows): a StatusDot + plain-language label,
  // rendered where Browse rows show their summary.
  status?: React.ReactNode
  actions?: React.ReactNode
  selected?: boolean
  // When present the name/summary area is a button that opens the detail panel.
  onOpen?: () => void
  // 'card' — the Browse idiom: two lines, summary visible.
  // 'compact' — the Installed idiom (Linear/Cursor density): one single-line
  //   row, status and actions right-aligned, summary demoted to a hover
  //   tooltip. Both are list-rows: no border box, fills carry hover/selection.
  variant?: 'card' | 'compact'
}) {
  if (variant === 'compact') {
    const nameAndChips = (
      <>
        <TruncatedText
          as="span"
          text={name}
          className="min-w-0 text-body font-medium leading-5 text-[color:var(--text-strong)]"
        />
        {chips.map((label) => (
          <ConnectorChip key={label} label={label} />
        ))}
      </>
    )
    return (
      <div
        title={summary}
        className={`group relative flex min-w-0 items-center gap-2.5 rounded-md px-3 py-1.5 transition-colors hover:bg-[color:var(--bg-hover)] ${
          selected ? 'bg-[color:var(--bg-selected)]' : ''
        }`}
      >
        {icon}
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-expanded={selected}
            aria-label={`Show details for ${name}`}
            className="interactive flex min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:focus-ring"
          >
            {nameAndChips}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">{nameAndChips}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-meta leading-4 text-[color:var(--text-subtle)]">
          {status}
          {actions}
        </span>
      </div>
    )
  }
  // list-row, not a card: no border box — the grid's gaps separate rows, and
  // the standard fills carry hover (--bg-hover) and selection (--bg-selected).
  const rowClass = selected
    ? 'bg-[color:var(--bg-selected)]'
    : 'hover:bg-[color:var(--bg-hover)]'
  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <TruncatedText
            as="span"
            text={name}
            className="min-w-0 text-body font-semibold leading-5 text-[color:var(--text-strong)]"
          />
          {chips.map((label) => (
            <ConnectorChip key={label} label={label} />
          ))}
        </span>
        {summary ? (
          <TruncatedText
            as="span"
            text={summary}
            className="mt-0.5 block text-body leading-4 text-[color:var(--text-subtle)]"
          />
        ) : null}
        {status ? (
          <span className="mt-0.5 flex items-center gap-1.5 text-meta leading-4 text-[color:var(--text-subtle)]">
            {status}
          </span>
        ) : null}
      </span>
    </>
  )
  return (
    <div className={`group relative flex items-center gap-2 rounded-md p-2.5 transition-colors ${rowClass}`}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={selected}
          aria-label={`Show details for ${name}`}
          className="interactive flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:focus-ring"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{content}</div>
      )}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

// The Browse mapping: one ConnectorEntry (either source) → a ConnectorRow with
// the source's icon and affordances. Catalog entries add/launch in place;
// registry entries route through the detail panel's install flow via Get.
export function ConnectorEntryRow({
  entry,
  registryUrl,
  selected,
  onOpen,
  onToggleInstalled,
  onLaunch,
}: {
  entry: ConnectorEntry
  registryUrl: string | null
  selected: boolean
  onOpen: () => void
  // Catalog entries only — adds the server to the active set.
  onToggleInstalled?: () => void
  // Launchable connectors only.
  onLaunch?: () => void
}) {
  const icon =
    entry.source === 'catalog' && entry.catalogServer ? (
      <McpBrandIcon slug={mcpIconSlug(entry.id)} name={entry.name} icon={entry.catalogServer.icon} size={36} />
    ) : (
      <PluginIcon
        iconUrl={entry.plugin ? resolveIconUrl(registryUrl, entry.plugin.icon) : null}
        name={entry.name}
        size={36}
      />
    )
  return (
    <ConnectorRow
      icon={icon}
      name={entry.name}
      summary={entry.summary}
      chips={entry.componentLabels}
      selected={selected}
      onOpen={onOpen}
      actions={
        <>
          {entry.source === 'registry' ? (
            <GhostButton size="sm" onClick={onOpen} className="border border-[color:var(--border-default)]">
              Get
            </GhostButton>
          ) : entry.installed ? (
            <span className="flex items-center gap-1 pr-1 text-meta font-medium text-[color:var(--accent-primary)]">
              <svg
                viewBox="0 0 10 10"
                className="h-2.5 w-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="1.5,5 4,7.5 8.5,2.5" />
              </svg>
              Added
            </span>
          ) : onToggleInstalled ? (
            <GhostButton
              size="sm"
              onClick={onToggleInstalled}
              className="border border-[color:var(--border-default)]"
              aria-label={`Add ${entry.name}`}
            >
              Add
            </GhostButton>
          ) : null}
          {onLaunch ? (
            <PrimaryButton size="sm" onClick={onLaunch}>
              New chat
            </PrimaryButton>
          ) : null}
        </>
      }
    />
  )
}
