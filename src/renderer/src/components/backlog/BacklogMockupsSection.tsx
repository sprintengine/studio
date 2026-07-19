import { useEffect, useMemo, useState } from 'react'

import { Popover, Section, Tooltip, TruncatedText } from '../ui'
import { HtmlPreviewCard } from '../ui/HtmlPreviewCard'
import { basename, joinFilePath } from '../../utils/paths'
import { humanizeFileTitle } from '../workspace/guidedBrief/MockupPreviewPane'
import type { BacklogItem } from '../../utils/backlog'
import {
  backlogMockupResolutionCandidates,
  collectBacklogMockups,
  type BacklogMockupEntry,
} from '../../utils/backlogMockups'

// Detail-pane "Mockups" surface (MC-1485), the attachment analog of
// BacklogDependenciesSection. It renders the item's mockups — attached
// (frontmatter `mockups:`, removable) and body-detected (read-only) — as live
// scripts-off preview cards, plus an "Attach mockup…" popover so attachments can
// be added without leaving the pane. Attach/remove is persisted only through the
// item's `mockups:` frontmatter (onSetMockups → window.api.updateBacklogMockups
// → re-scan); nothing here holds disconnected local list state.
//
// The section renders for epics and leaf items alike (amendment 3: epics are
// exactly where design mockups attach); only a `type: mockup` item is exempt —
// it *is* the mockup. The panel gates on that.

// A mockup ref resolved against disk: which candidate root-relative path actually
// exists (amendment 2 tolerates both project-root and `backlog/`-relative refs)
// and its absolute path. `null` once the existence check has run and found none.
type ResolvedMockup = { relativePath: string; absolutePath: string }

export type BacklogMockupOpenTarget = {
  /** The ref as authored (attach key / dedupe identity). */
  path: string
  /** The resolved, existing root-relative path. */
  relativePath: string
  /** Its absolute on-disk path. */
  absolutePath: string
}

export function BacklogMockupsSection({
  item,
  folderPath,
  onOpenMockup,
  onSetMockups,
}: {
  item: BacklogItem
  // Absolute workspace root, for resolving refs to on-disk paths and listing the
  // mockups directory.
  folderPath: string
  // Open the resolved mockup in the panel's inline preview (T4). Only ever called
  // for a resolved (existing) entry.
  onOpenMockup: (target: BacklogMockupOpenTarget) => void
  // Rewrite the item's full attached `mockups:` list (null clears the line). The
  // service de-dupes/validates; the UI just sends the next set and re-scans.
  onSetMockups: (item: BacklogItem, mockups: string[] | null) => void
}): JSX.Element {
  const entries = useMemo(() => collectBacklogMockups(item), [item])
  const attached = useMemo(() => item.mockups ?? [], [item.mockups])

  // Existence per authored path: undefined = pending (render optimistically so a
  // present file never flickers to "missing"), a ResolvedMockup = found, null =
  // checked and missing (no silent fallback — an explicit missing row).
  const [resolved, setResolved] = useState<Map<string, ResolvedMockup | null>>(new Map())
  const pathsKey = entries.map((entry) => entry.path).join('|')

  useEffect(() => {
    if (!folderPath) return
    let cancelled = false
    void (async () => {
      const next = new Map<string, ResolvedMockup | null>()
      for (const entry of entries) {
        let found: ResolvedMockup | null = null
        for (const rel of backlogMockupResolutionCandidates(entry.path)) {
          const absolutePath = joinFilePath(folderPath, rel)
          try {
            if (await window.api.pathExists(absolutePath)) {
              found = { relativePath: rel, absolutePath }
              break
            }
          } catch {
            // Treat a probe error like "not found" for this candidate.
          }
        }
        next.set(entry.path, found)
      }
      if (!cancelled) setResolved(next)
    })()
    return () => {
      cancelled = true
    }
    // pathsKey captures the entry set; folderPath the resolution root.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPath, pathsKey])

  const removeAttached = (path: string): void => {
    const next = attached.filter((existing) => existing !== path)
    onSetMockups(item, next.length > 0 ? next : null)
  }

  const attachPath = (path: string): void => {
    if (attached.includes(path)) return
    onSetMockups(item, [...attached, path])
  }

  return (
    <Section
      title="Mockups"
      level={4}
      inset
      className="shrink-0 border-b border-[color:var(--border-subtle)] pb-2"
      action={
        <AttachMockupEditor folderPath={folderPath} attached={attached} onAttach={attachPath} />
      }
    >
      <div className="flex flex-col gap-2 px-3">
        {entries.length === 0 ? (
          <p className="py-0.5 text-[12px] text-[color:var(--text-disabled)]">
            No mockups attached. Use “Attach mockup…” to add one.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <MockupRow
                key={`${entry.source}:${entry.path}`}
                entry={entry}
                folderPath={folderPath}
                resolution={resolved.get(entry.path)}
                onOpen={onOpenMockup}
                onRemove={entry.source === 'attached' ? () => removeAttached(entry.path) : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

// One mockup row. A resolved (or still-pending) entry renders the shared live
// preview card as the open affordance; an attached entry adds a remove ×, a
// detected entry a read-only "found in item" caption. A checked-missing entry is
// a non-openable role="note" row carrying the path and a "missing" status word,
// mirroring the dangling-prerequisite note — no silent fallback.
function MockupRow({
  entry,
  folderPath,
  resolution,
  onOpen,
  onRemove,
}: {
  entry: BacklogMockupEntry
  folderPath: string
  resolution: ResolvedMockup | null | undefined
  onOpen: (target: BacklogMockupOpenTarget) => void
  onRemove?: () => void
}): JSX.Element {
  const title = humanizeFileTitle(basename(entry.path)) || basename(entry.path)

  if (resolution === null) {
    return (
      <li className="flex min-w-0 items-center gap-2">
        <Tooltip
          content={`${entry.path} was not found on disk. Update the path, or remove the attachment.`}
          placement="top"
          wrapperClassName="inline-flex min-w-0 flex-1"
        >
          <span
            tabIndex={0}
            role="note"
            aria-label={`${entry.path}: missing, no file on disk`}
            className="min-w-0 flex-1 truncate rounded px-1.5 py-1 font-mono text-[12px] text-[color:var(--text-disabled)] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
          >
            {entry.path}
          </span>
        </Tooltip>
        <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">Missing</span>
        {onRemove ? <RemoveButton label={`Remove missing mockup ${entry.path}`} onClick={onRemove} /> : null}
      </li>
    )
  }

  // Pending resolution: render optimistically against the first candidate so a
  // present file never flashes as missing while the async check runs.
  const optimistic =
    resolution ??
    (() => {
      const rel = backlogMockupResolutionCandidates(entry.path)[0] ?? entry.path
      return { relativePath: rel, absolutePath: joinFilePath(folderPath, rel) }
    })()

  return (
    <li className="relative flex min-w-0 flex-col gap-1">
      <HtmlPreviewCard
        absolutePath={optimistic.absolutePath}
        relativePath={entry.path}
        title={title}
        onOpen={() => onOpen({ path: entry.path, relativePath: optimistic.relativePath, absolutePath: optimistic.absolutePath })}
      />
      {entry.source === 'detected' ? (
        <span className="px-1 text-[10.5px] text-[color:var(--text-subtle)]">Found in this item</span>
      ) : null}
      {onRemove ? (
        <div className="absolute right-1.5 top-1.5">
          <RemoveButton label={`Remove mockup ${entry.path}`} onClick={onRemove} />
        </div>
      ) : null}
    </li>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <Tooltip content="Remove" placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="interactive inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[color:var(--bg-surface-raised)]/80 text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </Tooltip>
  )
}

// A discovered mockup file candidate for the attach popover: its project-root-
// relative path and the display title.
type MockupChoice = { relativePath: string; title: string }

// The two roots a mockup file can live under, in listing precedence: the
// canonical `backlog/mockups/` home first, then the legacy project-root
// `mockups/` (amendment 1).
const MOCKUP_DIRS: ReadonlyArray<string> = ['backlog/mockups', 'mockups']

// "Attach mockup…" popover: lists `.html` files under the mockup directories
// (newest-first via reverse-lexicographic sort of the `YYYY-MM-DD-slug.html`
// names — no stat calls), filter-as-you-type, already-attached files excluded,
// plus a free-text row so a file elsewhere can be attached by relative path.
function AttachMockupEditor({
  folderPath,
  attached,
  onAttach,
}: {
  folderPath: string
  attached: string[]
  onAttach: (relativePath: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [choices, setChoices] = useState<MockupChoice[]>([])

  useEffect(() => {
    if (!open || !folderPath) return
    let cancelled = false
    void (async () => {
      const found: MockupChoice[] = []
      const seen = new Set<string>()
      for (const dir of MOCKUP_DIRS) {
        let entries: Array<{ name: string; isDir: boolean }> = []
        try {
          entries = await window.api.readdir(joinFilePath(folderPath, dir))
        } catch {
          continue // a missing mockups dir is just no candidates from that root
        }
        const files = entries
          .filter((child) => !child.isDir && /\.html?$/i.test(child.name))
          .sort((a, b) => b.name.localeCompare(a.name)) // newest date-prefixed name first
        for (const file of files) {
          const relativePath = `${dir}/${file.name}`
          if (seen.has(relativePath)) continue
          seen.add(relativePath)
          found.push({ relativePath, title: humanizeFileTitle(file.name) || file.name })
        }
      }
      if (!cancelled) setChoices(found)
    })()
    return () => {
      cancelled = true
    }
  }, [open, folderPath])

  const attachedSet = useMemo(() => new Set(attached), [attached])
  const trimmedQuery = query.trim()
  const filtered = choices.filter(
    (choice) =>
      !attachedSet.has(choice.relativePath) &&
      (trimmedQuery === '' ||
        choice.relativePath.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
        choice.title.toLowerCase().includes(trimmedQuery.toLowerCase())),
  )

  // A free-text attach is offered when the query looks like a workspace-relative
  // HTML path the list doesn't already include (and isn't already attached).
  const freeTextPath = trimmedQuery.replace(/\\/g, '/')
  const freeTextValid =
    /\.html?$/i.test(freeTextPath) &&
    !freeTextPath.startsWith('/') &&
    !freeTextPath.split('/').includes('..') &&
    !attachedSet.has(freeTextPath) &&
    !filtered.some((choice) => choice.relativePath === freeTextPath)

  const commit = (relativePath: string): void => {
    onAttach(relativePath)
    setQuery('')
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      ariaLabel="Attach a mockup"
      popupRole="dialog"
      placement="bottom-end"
      surfaceClassName="min-w-[20rem] p-1"
      renderTrigger={({ ref, togglePopover, open: opened, triggerProps }) => (
        <button
          ref={ref}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          onClick={togglePopover}
          className={`interactive inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[color:var(--bg-hover)] ${
            opened
              ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
              : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
          }`}
        >
          Attach mockup…
        </button>
      )}
    >
      <div className="flex flex-col gap-1">
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search mockups or type a path…"
          aria-label="Search mockup files"
          className="w-full rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 py-1 text-[12px] text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--border-strong)]"
        />
        <ul role="listbox" aria-label="Mockup files" className="flex max-h-64 flex-col gap-0.5 overflow-auto">
          {filtered.map((choice) => (
            <li key={choice.relativePath}>
              <button
                type="button"
                onClick={() => commit(choice.relativePath)}
                className="interactive flex w-full min-w-0 flex-col rounded px-2 py-1 text-left transition-colors hover:bg-[color:var(--bg-hover)]"
              >
                <span className="truncate text-[12px] text-[color:var(--text-default)]">{choice.title}</span>
                <TruncatedText
                  as="span"
                  text={choice.relativePath}
                  className="font-mono text-[10px] text-[color:var(--text-subtle)]"
                />
              </button>
            </li>
          ))}
          {freeTextValid ? (
            <li>
              <button
                type="button"
                onClick={() => commit(freeTextPath)}
                className="interactive flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)]"
              >
                <span className="text-[color:var(--text-muted)]">Attach path</span>
                <span className="truncate font-mono text-[11px]">{freeTextPath}</span>
              </button>
            </li>
          ) : null}
          {filtered.length === 0 && !freeTextValid ? (
            <li className="px-2 py-1 text-[11px] text-[color:var(--text-disabled)]">
              {choices.length === 0 ? 'No mockup files found under backlog/mockups.' : 'No matching mockups.'}
            </li>
          ) : null}
        </ul>
      </div>
    </Popover>
  )
}
