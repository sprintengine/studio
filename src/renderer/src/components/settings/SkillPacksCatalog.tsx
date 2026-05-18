import React, { useEffect } from 'react'
import type { SkillPackCatalogEntry, SkillPackHarness } from '../../types/workspace'
import { GhostButton, PrimaryButton } from '../ui'

export function groupSkillPackCatalog(
  packs: SkillPackCatalogEntry[],
): Array<[string, SkillPackCatalogEntry[]]> {
  const groups = new Map<string, SkillPackCatalogEntry[]>()
  for (const pack of packs) {
    const category = pack.category?.trim() || 'Other'
    groups.set(category, [...(groups.get(category) ?? []), pack])
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))
}

function skillPackMonogram(name: string): string {
  return name
    .split(/[\s-]+/u)
    .map((piece) => piece[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function SkillPackMonogram({
  name,
  size = 36,
}: {
  name: string
  size?: number
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      className="grid place-items-center rounded-md bg-[color:var(--bg-active)] font-mono font-semibold text-[color:var(--text-default)]"
    >
      {skillPackMonogram(name)}
    </span>
  )
}

export function SkillPackTile({
  pack,
  installed,
  pending,
  selected,
  onToggle,
  onInfo,
}: {
  pack: SkillPackCatalogEntry
  installed: boolean
  pending: boolean
  selected: boolean
  onToggle: () => void
  onInfo: () => void
}) {
  const tileClass = installed
    ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
    : selected
      ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)]'
      : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)]'
  return (
    <div className="relative aspect-square">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={installed}
        aria-busy={pending}
        aria-label={installed ? `Remove ${pack.name}` : `Install ${pack.name}`}
        disabled={pending}
        className={`interactive flex h-full w-full flex-col items-start justify-between rounded-md border p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] disabled:cursor-progress ${tileClass}`}
      >
        <SkillPackMonogram name={pack.name} size={36} />
        {installed ? (
          <span
            aria-hidden
            className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]"
          >
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
          </span>
        ) : pending ? (
          <span
            aria-hidden
            className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-[color:var(--bg-active)] text-[color:var(--text-subtle)]"
          >
            <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          </span>
        ) : null}
        <div className="w-full min-w-0 pr-6">
          <div className="truncate text-[13px] font-semibold leading-5 text-[color:var(--text-strong)]">
            {pack.name}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] leading-3 text-[color:var(--text-subtle)]">
            {pack.slug}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onInfo}
        aria-label={`Show details for ${pack.name}`}
        aria-expanded={selected}
        className={`interactive absolute bottom-2 right-2 z-10 grid h-5 w-5 place-items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
          selected
            ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
            : 'text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-default)]'
        }`}
      >
        <svg viewBox="0 0 16 16" className="icon-sm" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5A5.5 5.5 0 118 2.5a5.5 5.5 0 010 11zM7.25 5.5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.25a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4z" />
        </svg>
      </button>
    </div>
  )
}

export function SkillPackInfoPanel({
  pack,
  installed,
  pending,
  onToggle,
  onClose,
}: {
  pack: SkillPackCatalogEntry
  installed: boolean
  pending: boolean
  onToggle: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      aria-label={`${pack.name} details`}
      className="sticky top-2 w-72 shrink-0 self-start rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <SkillPackMonogram name={pack.name} size={32} />
          <div className="min-w-0">
            <h5 className="truncate text-[14px] font-semibold leading-5 text-[color:var(--text-strong)]">
              {pack.name}
            </h5>
            <div className="mt-0.5 truncate font-mono text-[11px] text-[color:var(--text-subtle)]">
              {pack.slug}
              {pack.version ? ` · v${pack.version}` : ''}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="interactive grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          <svg viewBox="0 0 12 12" className="icon-xs" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      {pack.description ? (
        <p className="mt-3 text-[12px] leading-5 text-[color:var(--text-muted)]">{pack.description}</p>
      ) : null}
      {pack.harnesses.length ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Harnesses</div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-[color:var(--text-muted)]">
            {pack.harnesses.map((harness) => (
              <span key={harness}>{HARNESS_LABEL[harness]}</span>
            ))}
          </div>
        </div>
      ) : null}
      {pack.setupNotes ? (
        <p className="mt-3 border-l border-[color:var(--border-strong)] pl-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {pack.setupNotes}
        </p>
      ) : null}
      {pack.sourceUrl ? (
        <a
          href={pack.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex text-[12px] font-semibold text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] focus:outline-none focus-visible:underline"
        >
          Source
        </a>
      ) : null}
      <div className="mt-4">
        {installed ? (
          <GhostButton
            onClick={onToggle}
            size="md"
            disabled={pending}
            className="h-9 w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            {pending ? 'Removing' : 'Remove'}
          </GhostButton>
        ) : (
          <PrimaryButton onClick={onToggle} size="md" disabled={pending} className="h-9 w-full">
            {pending ? 'Installing' : 'Install'}
          </PrimaryButton>
        )}
      </div>
    </aside>
  )
}

const HARNESS_LABEL: Record<SkillPackHarness, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  agents: 'AGENTS',
}
