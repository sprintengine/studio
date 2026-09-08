// ConnectorRow — the one list row the whole Connectors surface renders: Browse
// (catalog + registry via ConnectorEntryRow) and the Installed view (via the
// generic ConnectorRow) share it so the surface reads as one system. Icon chip ·
// name + kind chip · one-line summary (or status line) · right-aligned
// actions. Transport and other plumbing stay off the row face — they belong to
// the detail panels. There is one row, not a "compact" cousin: the Installed
// view once had its own single-line idiom and read as a different product from
// the grid beside it.

import React from 'react'

import { Badge, GhostButton, PrimaryButton, RowButton, TruncatedText } from '../../ui'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
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

// Small neutral text chip ("MCP server", "Skill pack", "Bundled", "http", …):
// the kit's label badge, decorative because the row's name and summary already
// say what it is.
function ConnectorChip({ label }: { label: string }) {
  return (
    <Badge decorative className="shrink-0">
      {label}
    </Badge>
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
}: {
  icon: React.ReactNode
  name: string
  summary?: string
  chips?: string[]
  // Optional status line (Installed rows): a StatusDot + plain-language label,
  // rendered under the summary.
  status?: React.ReactNode
  actions?: React.ReactNode
  selected?: boolean
  // When present the name/summary area is a button that opens the detail panel.
  onOpen?: () => void
}) {
  // list-row, not a card: no border box — the grid's gaps separate rows, and
  // the standard fills carry hover (--bg-hover) and selection (--bg-selected).
  const rowClass = selected
    ? 'bg-[color:var(--bg-selected)]'
    : 'hover:bg-[color:var(--bg-hover)]'
  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        {/* overflow-hidden, because the chips are shrink-0: once the name has
            truncated away, a chip row wider than the column would otherwise
            paint on under the right-aligned actions (seen in the condensed
            Plugins modal). Clipping is the row's contract — the detail panel
            carries the full component list. */}
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
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
          // Clipped, not wrapped — the same contract the name row keeps above.
          // A state line long enough to wrap ("Active · No longer in source")
          // would grow this row taller than its neighbours and step the whole
          // list out of rhythm; the detail surfaces carry the full sentence.
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-meta leading-4 text-[color:var(--text-subtle)]">
            {status}
          </span>
        ) : null}
      </span>
    </>
  )
  return (
    // The row's own inset moved onto the two content branches, because the
    // interactive one is now `RowButton density="flush"` and the kit owns a row's
    // padding. The non-interactive twin repeats it verbatim so the two branches
    // stay the same shape; this element keeps the ground, the radius and the
    // right-hand inset the trailing actions sit in.
    <div className={`group relative flex items-center gap-2 rounded-md pr-2.5 transition-colors ${rowClass}`}>
      {onOpen ? (
        <RowButton
          density="flush"
          onClick={onOpen}
          aria-expanded={selected}
          aria-label={`Show details for ${name}`}
          className="min-w-0 flex-1"
        >
          {content}
        </RowButton>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">{content}</div>
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
  // Installed entries only — removes the server from the active set.
  onToggleInstalled?: () => void
  // Launchable connectors only.
  onLaunch?: () => void
}) {
  const icon = entry.plugin ? (
    <PluginIcon iconUrl={resolveIconUrl(registryUrl, entry.plugin.icon)} name={entry.name} size={36} />
  ) : (
    <ExtensionIcon slug={mcpIconSlug(entry.id)} name={entry.name} size={36} />
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
