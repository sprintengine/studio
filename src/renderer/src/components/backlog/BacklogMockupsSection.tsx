import React, { useEffect, useMemo, useRef, useState } from 'react'

import {
  GhostButton,
  IconButton,
  Input,
  MENU_LIST_CLASS,
  MenuOption,
  Popover,
  Section,
  Tooltip,
  TruncatedText,
} from '../ui'
import { HtmlPreviewCard } from '../ui'
import { basename, joinFilePath } from '../../utils/paths'
import { humanizeFileTitle } from '../htmlArtifact/HtmlArtifactFrame'
import type { BacklogItem } from '../../utils/backlog'
import {
  backlogMockupResolutionCandidates,
  collectBacklogMockups,
  resolveFirstMockupCandidate,
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
        const found = await resolveFirstMockupCandidate(entry.path, async (relativePath) => {
          const absolutePath = joinFilePath(folderPath, relativePath)
          return (await window.api.pathExists(absolutePath)) ? { relativePath, absolutePath } : null
        })
        next.set(entry.path, found)
      }
      if (!cancelled) setResolved(next)
    })()
    return () => {
      cancelled = true
    }
    // pathsKey captures the entry set; folderPath the resolution root.
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
      // No hairline: padding and the heading separate this section from the next
      // (MC-2047 — "space groups, rules do not").
      className="shrink-0 pb-2"
      action={
        <AttachMockupEditor folderPath={folderPath} attached={attached} onAttach={attachPath} />
      }
    >
      {/* An empty section is the heading and its "Attach mockup…" action, and
          nothing else. The sentence that used to sit here named that control and
          explained it — the standing ruling is that a control needing a sentence
          is the wrong control, so the control stands alone (MC-2047). */}
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-2 px-3">
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
      ) : null}
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
            // Readable ink: the path is what a person reads to fix the row, so it
            // is never disabled ink — the "Missing" word beside it carries state.
            className="min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 font-mono text-meta text-[color:var(--text-muted)] outline-none focus-visible:focus-ring"
          >
            {entry.path}
          </span>
        </Tooltip>
        <span className="shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">Missing</span>
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
    <li className="group relative flex min-w-0 flex-col gap-1">
      <HtmlPreviewCard
        absolutePath={optimistic.absolutePath}
        relativePath={entry.path}
        title={title}
        onOpen={() => onOpen({ path: entry.path, relativePath: optimistic.relativePath, absolutePath: optimistic.absolutePath })}
      />
      {entry.source === 'detected' ? (
        <span className="px-1 text-micro text-[color:var(--text-subtle)]">Found in this item</span>
      ) : null}
      {/* The raised ground sits on the wrapper, not the buttons: it keeps the
          glyphs legible over the preview while the kit buttons keep their own
          hover fill. Open-in-browser is hover/focus-revealed (it is a shortcut
          past the inline preview, not the row's primary open); Remove stays
          always-visible as before. */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-sm bg-[color:var(--bg-surface-raised)]">
        <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <OpenInBrowserButton path={entry.path} absolutePath={optimistic.absolutePath} />
        </span>
        {onRemove ? <RemoveButton label={`Remove mockup ${entry.path}`} onClick={onRemove} /> : null}
      </div>
    </li>
  )
}

// Hover/focus-revealed jump straight to the default browser — the same
// `openHtmlFileInBrowser` bridge the full preview pane's "Open in browser"
// uses, without going through the inline preview first.
function OpenInBrowserButton({ path, absolutePath }: { path: string; absolutePath: string }): JSX.Element {
  return (
    <Tooltip content="Open in browser" placement="top">
      <IconButton
        aria-label={`Open ${path} in browser`}
        onClick={(event) => {
          event.stopPropagation()
          void window.api.openHtmlFileInBrowser(absolutePath)
        }}
        className="shrink-0"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path
            d="M9.5 3H13v3.5M13 3L7.5 8.5M6.5 3.5H4.2C3.5 3.5 3 4 3 4.7v7.1c0 .7.5 1.2 1.2 1.2h7.1c.7 0 1.2-.5 1.2-1.2V9.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

// The kit's icon button (26px, the one control-xs square) — this was a 20px
// hand-rolled square under the 24px hit-target floor.
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <Tooltip content="Remove" placement="top">
      <IconButton aria-label={label} onClick={onClick} className="shrink-0">
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </IconButton>
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

  // The listbox keyboard model (design-system/components/menu → Accessibility):
  // ArrowDown from the search field enters the list; ArrowUp/Down wrap through
  // the options; Home/End jump. The surface stays a `listbox` of `option`s —
  // these are values to pick, not actions — so the kit's `roveMenuFocus`, which
  // walks a `role="menu"`, is mirrored here over the option rows.
  //
  // The combobox ruling (design-system/components/combobox → Keyboard): keys the
  // caret has a claim on reach the list only when the caret cannot use them. So
  // from inside the text field ONLY ArrowDown leaves — Home/End/ArrowUp stay with
  // the caret. Once focus is on an option row the caret has no claim and all four
  // keys rove.
  const listRef = useRef<HTMLUListElement | null>(null)
  const optionsOf = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([disabled])') ?? [])
  const roveOptions = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const target = event.target as HTMLElement | null
    const fromField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
    if (fromField && event.key !== 'ArrowDown') return
    const options = optionsOf()
    if (options.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    const active = document.activeElement as HTMLElement | null
    const index = active ? options.indexOf(active) : -1
    const next =
      event.key === 'Home'
        ? options[0]
        : event.key === 'End'
          ? options[options.length - 1]
          : event.key === 'ArrowDown'
            ? index < 0 ? options[0] : options[(index + 1) % options.length]
            : index < 0 ? options[options.length - 1] : options[(index - 1 + options.length) % options.length]
    next?.focus()
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
      // No surface inset: the option rows are full-bleed (the menu list layer),
      // and the search field carries its own gutter.
      surfaceClassName="min-w-[20rem]"
      renderTrigger={({ ref, togglePopover, open: opened, triggerProps }) => (
        <GhostButton
          ref={ref}
          size="xs"
          aria-haspopup="dialog"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          onClick={togglePopover}
          className={opened ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : ''}
        >
          Attach mockup…
        </GhostButton>
      )}
    >
      <div className="flex flex-col" onKeyDown={roveOptions}>
        <div className="p-1.5">
          <Input
            type="text"
            size="sm"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search mockups or type a path…"
            aria-label="Search mockup files"
          />
        </div>
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Mockup files"
          className={`flex max-h-64 flex-col overflow-auto ${MENU_LIST_CLASS}`}
        >
          {filtered.map((choice) => (
            <li key={choice.relativePath}>
              <MenuOption
                role="option"
                stacked
                data-menu-item="true"
                tabIndex={-1}
                onClick={() => commit(choice.relativePath)}
              >
                <span className="truncate text-meta">{choice.title}</span>
                <TruncatedText
                  as="span"
                  text={choice.relativePath}
                  className="font-mono text-micro text-[color:var(--text-subtle)]"
                />
              </MenuOption>
            </li>
          ))}
          {freeTextValid ? (
            <li>
              <MenuOption
                role="option"
                stacked
                data-menu-item="true"
                tabIndex={-1}
                onClick={() => commit(freeTextPath)}
              >
                <span className="flex min-w-0 items-center gap-1 text-meta">
                  <span className="shrink-0 text-[color:var(--text-muted)]">Attach path</span>
                  <span className="truncate font-mono text-micro">{freeTextPath}</span>
                </span>
              </MenuOption>
            </li>
          ) : null}
          {filtered.length === 0 && !freeTextValid ? (
            <li className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">
              {choices.length === 0 ? 'No mockup files found under backlog/mockups.' : 'No matching mockups.'}
            </li>
          ) : null}
        </ul>
      </div>
    </Popover>
  )
}
