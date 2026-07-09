import React, { useEffect } from 'react'
import type { SkillPackCatalogEntry, SkillPackHarness } from '../../types/workspace'
import { GhostButton, PrimaryButton, TruncatedText } from '../ui'

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
      className="grid place-items-center rounded-lg border border-[color:var(--icon-chip-border)] bg-[color:var(--icon-chip-bg)] font-mono font-semibold text-[color:var(--icon-chip-ink)]"
    >
      {skillPackMonogram(name)}
    </span>
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
            <TruncatedText
              as="h5"
              text={pack.name}
              className="text-[14px] font-semibold leading-5 text-[color:var(--text-strong)]"
            />
            <TruncatedText
              as="div"
              text={`${pack.slug}${pack.version ? ` · v${pack.version}` : ''}`}
              className="mt-0.5 text-[11px] text-[color:var(--text-subtle)]"
            />
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
          <div className="mt-1 flex flex-wrap gap-1">
            {pack.harnesses.map((harness) => (
              <span
                key={harness}
                className="rounded-full bg-[color:var(--bg-active)] px-1.5 py-0.5 text-[10px] leading-3 text-[color:var(--text-subtle)]"
              >
                {HARNESS_LABEL[harness]}
              </span>
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
  grok: 'Grok',
  agents: 'AGENTS',
}
