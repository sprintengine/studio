import { useEffect, useRef } from 'react'
import type { ConversationCommand } from '../../../../../shared/conversation/commands'
import { MenuOption, Popover, Spinner, TruncatedText } from '../../ui'

// The `/` menu: the commands the chat's CLI said it runs in this folder, with
// Studio's own few first. Focus never leaves the composer — the field is the
// combobox and this is its listbox, so the view forwards ↑↓/⏎/⇥/esc and the
// highlighted row is named by `aria-activedescendant` rather than by focus.

const SOURCE_ORDER: Record<ConversationCommand['source'], number> = { app: 0, cli: 1, custom: 2, skill: 3 }

/** The quiet label at a row's trailing edge: where the command comes from. */
export function commandSourceLabel(source: ConversationCommand['source'], cliLabel: string): string {
  return source === 'app' ? 'Studio' : source === 'cli' ? cliLabel : source === 'custom' ? 'Custom' : 'Skill'
}

// Lower is better. A name (or an alias — `/cost` finds `usage`) beats any
// description match, so typing a command's name never loses it to a command
// that merely mentions the word; within names, the closer the match the
// earlier the row.
function nameScore(name: string, query: string): number | null {
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  for (let index = name.indexOf(query); index > 0; index = name.indexOf(query, index + 1))
    if (/[-_:.]/u.test(name[index - 1])) return 2
  if (name.includes(query)) return 3
  let next = 0
  for (const character of name) if (character === query[next]) next++
  return next === query.length ? 4 : null
}

function commandScore(command: ConversationCommand, query: string): number | null {
  let best: number | null = null
  for (const name of [command.name, ...(command.aliases ?? [])]) {
    const score = nameScore(name.toLowerCase(), query)
    if (score !== null && (best === null || score < best)) best = score
  }
  if (best !== null) return best
  return command.description?.toLowerCase().includes(query) ? 5 : null
}

/**
 * The rows for a query, best first: exact name, name prefix, a match at a
 * word boundary inside the name, anywhere in the name, the name's letters in
 * order, then the description. Equal matches go Studio → CLI built-ins →
 * custom commands → skills, then by name.
 */
export function rankConversationCommands(
  commands: readonly ConversationCommand[],
  query: string,
): ConversationCommand[] {
  const needle = query.trim().toLowerCase().replace(/^\//u, '')
  return commands
    .map((command) => ({ command, score: needle ? commandScore(command, needle) : 0 }))
    .filter((entry): entry is { command: ConversationCommand; score: number } => entry.score !== null)
    .sort(
      (a, b) =>
        a.score - b.score ||
        SOURCE_ORDER[a.command.source] - SOURCE_ORDER[b.command.source] ||
        a.command.name.localeCompare(b.command.name),
    )
    .map((entry) => entry.command)
}

/** What choosing a row puts in the composer in place of the `/query` token. */
export function commandInsertText(command: ConversationCommand): string {
  return command.insertText ?? `/${command.name} `
}

export type SlashCommandMenuStatus = {
  /** The CLI as the person knows it, e.g. "Claude Code". */
  cliLabel: string
  loading: boolean
  error?: string
  /** The CLI has answered for this folder, so an empty list is its answer rather than a gap. */
  answered: boolean
  /** How many of the commands came from the CLI rather than from Studio. */
  reportedCount: number
}

export function SlashCommandMenu({
  listId,
  optionId,
  rows,
  activeIndex,
  query,
  status,
  skillsHint,
  onActiveIndexChange,
  onPick,
  onDismiss,
}: {
  listId: string
  optionId: (index: number) => string
  rows: readonly ConversationCommand[]
  activeIndex: number
  query: string
  status: SlashCommandMenuStatus
  /** Say that `$` is where Studio's own skills are, when the chat takes them. */
  skillsHint: boolean
  onActiveIndexChange: (index: number) => void
  onPick: (command: ConversationCommand) => void
  onDismiss: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, rows])
  const trimmed = query.trim()
  const notice = status.error ? (
    <p role="status" className="px-2.5 py-2 text-meta text-[color:var(--tone-error)]">
      Couldn’t list {status.cliLabel} commands: {status.error}
    </p>
  ) : status.loading ? (
    <p role="status" className="flex items-center gap-2 px-2.5 py-2 text-meta text-[color:var(--text-muted)]">
      <Spinner />
      Loading commands…
    </p>
  ) : rows.length === 0 && trimmed ? (
    <p role="status" className="px-2.5 py-2 text-meta text-[color:var(--text-muted)]">
      No command matches “/{trimmed}”. ⏎ sends it as typed.
    </p>
  ) : status.answered && status.reportedCount === 0 && !trimmed ? (
    <p role="status" className="px-2.5 py-2 text-meta text-[color:var(--text-muted)]">
      {status.cliLabel} reported no commands
    </p>
  ) : null
  return (
    // A layer over the composer box, so the surface spans the field it
    // completes and sits on its top edge — the same anchor the file type-ahead
    // uses. Not `aria-hidden`: the popover shell reads a hidden anchor as its
    // trigger having left the screen, and closes.
    <div className="pointer-events-none absolute inset-0 flex">
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) onDismiss()
        }}
        ariaLabel="Commands"
        popupRole="dialog"
        placement="top-start"
        material="glass"
        className="w-full"
        renderTrigger={() => null}
        surfaceClassName="w-[var(--popover-trigger-width)] max-w-[calc(100vw-16px)]"
      >
        {/* `contain: inline-size` keeps the rows' text out of the surface's
            natural width. The shell measures the surface once, before it has
            the composer's width to wear, and a list as wide as its longest
            description would be clamped left off the composer's edge. */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1 [contain:inline-size]">
          {/* The listbox the field points into holds the rows alone: a status
              line or the key hints inside it would be read as options. */}
          <div role="listbox" id={listId} aria-label="Commands">
            {rows.map((command, index) => (
              <MenuOption
                key={`${command.source}:${command.name}`}
                id={optionId(index)}
                role="option"
                selected={index === activeIndex}
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (index !== activeIndex) onActiveIndexChange(index)
                }}
                onClick={() => onPick(command)}
                trailing={
                  <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">
                    {commandSourceLabel(command.source, status.cliLabel)}
                  </span>
                }
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono font-medium text-[color:var(--text-strong)]">
                    {commandInsertText(command).trim()}
                  </span>
                  {command.argumentHint ? (
                    <span className="max-w-[30%] shrink-0 truncate font-mono text-[color:var(--text-subtle)]">
                      {command.argumentHint}
                    </span>
                  ) : null}
                  {command.description ? (
                    <TruncatedText
                      as="span"
                      text={command.description}
                      className="min-w-0 flex-1 text-[color:var(--text-muted)]"
                    />
                  ) : null}
                </span>
              </MenuOption>
            ))}
          </div>
          {notice}
        </div>
        <div className="flex items-center gap-2 border-t border-[color:var(--border-subtle)] px-2.5 py-1.5 text-micro text-[color:var(--text-subtle)]">
          <span>↑↓ choose · ⏎ or tab insert · esc dismiss</span>
          {skillsHint ? <span className="ml-auto">$ for Studio skills</span> : null}
        </div>
      </Popover>
    </div>
  )
}
