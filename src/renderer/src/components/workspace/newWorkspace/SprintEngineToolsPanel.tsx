// The sprint wizard's Tools & skills step (MC-1646, mockup §3): the old
// "Advanced setup" accordion's contents as one optional, searchable page.
// Tool rows carry a curated display name and a one-line purpose; the raw
// transport/category ids drop to mono meta at the trailing edge — a raw server
// id is never a row's primary name (see utils/mcpDisplayName). Seven available
// rows show at rest with the remainder behind "Show all", not a scrollbar.
// Skill packs, the knowledge graph, and the design-system attach complete the
// accordion's contents as further groups reusing the same row pattern.

import React, { type MutableRefObject } from 'react'

import type { McpCatalogServer } from '../../../types/workspace'
import type { DesignSystemAttachSource } from '../../../../../shared/design-system/attach'
import { mcpServerDisplayName, mcpServerPurpose } from '../../../utils/mcpDisplayName'
import { DesignSystemAttachStep } from './DesignSystemAttachStep'
import { KnowledgeStep } from './KnowledgeStep'

const AVAILABLE_ROWS_AT_REST = 7

export function SprintEngineToolsPanel({
  mcpCatalog,
  mcpSettings,
  onToggleMcp,
  message,
  knowledgeProjectRoot,
  committedKnowledgeRoot,
  onCommitKnowledge,
  knowledgeAutoAppliedRef,
  designSystemAttachRoot,
  designSystemAttachSelection,
  onSelectDesignSystemAttach,
}: {
  mcpCatalog: McpCatalogServer[]
  mcpSettings: { servers: Record<string, { enabled: boolean }> } | null
  onToggleMcp: (server: McpCatalogServer) => void
  message: string | null
  /** Project root when the knowledge section applies; null hides it. */
  knowledgeProjectRoot: string | null
  committedKnowledgeRoot: string | null
  onCommitKnowledge: (relativeRoot: string | null) => void
  knowledgeAutoAppliedRef: MutableRefObject<Set<string>>
  /** Materialized workspace folder when attach is offered; null hides it. */
  designSystemAttachRoot: string | null
  designSystemAttachSelection: DesignSystemAttachSource | null
  onSelectDesignSystemAttach: (source: DesignSystemAttachSource | null) => void
}) {
  const [query, setQuery] = React.useState('')
  const [showAllTools, setShowAllTools] = React.useState(false)

  const q = query.trim().toLowerCase()
  const matches = (haystacks: Array<string | undefined>) =>
    !q || haystacks.some((value) => value?.toLowerCase().includes(q))

  const enabledMcp = (server: McpCatalogServer) => Boolean(mcpSettings?.servers[server.id]?.enabled)
  const filteredServers = mcpCatalog.filter((server) =>
    matches([mcpServerDisplayName(server), server.name, server.category, mcpServerPurpose(server)]),
  )
  const selectedServers = filteredServers.filter(enabledMcp)
  const availableServers = filteredServers.filter((server) => !enabledMcp(server))
  // A search shows every match; at rest the long tail sits behind "Show all".
  const collapsed = !q && !showAllTools && availableServers.length > AVAILABLE_ROWS_AT_REST
  const visibleAvailable = collapsed ? availableServers.slice(0, AVAILABLE_ROWS_AT_REST) : availableServers

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-[30px] items-center gap-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5">
        <span aria-hidden="true" className="text-[12px] text-[color:var(--text-subtle)]">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tools"
          aria-label="Search tools"
          className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-subtle)]"
        />
      </div>

      {mcpCatalog.length === 0 ? (
        <p className="mt-3 text-[11px] text-[color:var(--text-subtle)]">Loading tools…</p>
      ) : (
        <>
          {selectedServers.length > 0 ? (
            <ToolGroup label="Selected">
              {selectedServers.map((server) => (
                <McpToolRow key={server.id} server={server} enabled onToggle={() => onToggleMcp(server)} />
              ))}
            </ToolGroup>
          ) : null}
          <ToolGroup label="Available">
            {visibleAvailable.length === 0 ? (
              <p className="py-2 text-[11px] text-[color:var(--text-subtle)]">
                {q ? 'No tools match the search.' : 'Every catalog tool is selected.'}
              </p>
            ) : (
              visibleAvailable.map((server) => (
                <McpToolRow key={server.id} server={server} enabled={false} onToggle={() => onToggleMcp(server)} />
              ))
            )}
            {collapsed ? (
              <button
                type="button"
                onClick={() => setShowAllTools(true)}
                className="self-start py-2 text-[12px] font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
              >
                Show all {mcpCatalog.length} tools
              </button>
            ) : null}
          </ToolGroup>
        </>
      )}

      {message ? <p className="mt-2 text-[11px] leading-4 text-[color:var(--text-muted)]">{message}</p> : null}

      {knowledgeProjectRoot ? (
        <ToolGroup label="Knowledge graph">
          <div className="pt-1">
            <KnowledgeStep
              projectRoot={knowledgeProjectRoot}
              committedRelativeRoot={committedKnowledgeRoot}
              onCommit={onCommitKnowledge}
              autoApplyGuard={knowledgeAutoAppliedRef}
            />
          </div>
        </ToolGroup>
      ) : null}

      {designSystemAttachRoot ? (
        <ToolGroup label="Design system">
          <div className="pt-1">
            <DesignSystemAttachStep
              workspaceRoot={designSystemAttachRoot}
              selection={designSystemAttachSelection}
              onSelect={onSelectDesignSystemAttach}
            />
          </div>
        </ToolGroup>
      ) : null}
    </div>
  )
}

function ToolGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3.5 flex flex-col">
      <div className="mb-0.5 text-micro font-semibold text-[color:var(--text-subtle)]">
        {label}
      </div>
      {children}
    </div>
  )
}

function RowCheck({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-sm border ${
        checked
          ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--bg-app)]'
          : 'border-[color:var(--border-strong)] bg-[color:var(--bg-surface)]'
      }`}
    >
      {checked ? (
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1.5,5 4,7.5 8.5,2.5" />
        </svg>
      ) : null}
    </span>
  )
}

// One hairline tool row: checkbox glyph · curated display name · one-line
// purpose · mono transport/category meta. The whole row toggles.
function McpToolRow({
  server,
  enabled,
  onToggle,
}: {
  server: McpCatalogServer
  enabled: boolean
  onToggle: () => void
}) {
  const displayName = mcpServerDisplayName(server)
  const purpose = mcpServerPurpose(server)
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={onToggle}
      className="
        flex h-9 w-full items-center gap-3 border-b border-[color:var(--border-subtle)] text-left transition-colors
        hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring-inset
      "
    >
      <RowCheck checked={enabled} />
      <span className="min-w-[150px] shrink-0 text-[12px] font-medium text-[color:var(--text-strong)]">
        {displayName}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--text-subtle)]">{purpose}</span>
      <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">
        {server.transport}
        {server.category ? ` · ${server.category.toLowerCase()}` : ''}
      </span>
    </button>
  )
}
