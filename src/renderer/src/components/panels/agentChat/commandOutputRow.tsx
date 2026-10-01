// What a slash command printed when the CLI ran it by itself (`/context`,
// `/usage`): the turn's whole answer, since no model replied. It is content —
// selectable and copied with the transcript like a reply — but it is the CLI's
// own report rather than prose, so it sits in a quiet block headed by the
// command that printed it, the way the work timeline shows a shell command's
// output. Claude Code writes these reports as markdown (headings, tables), so
// plain output is rendered as markdown one step smaller than a reply, read as
// a report is printed: every newline a line break (`**Model:** …` and
// `**Tokens:** …` are two lines, not one sentence) and any HTML as text. Output
// that carries terminal colours is a terminal's, drawn on the terminal's ground
// with them. The copy glyph copies the text as the CLI printed it either way.

import { useMemo } from 'react'
import { parseAnsi } from '../../../../../shared/conversation/ansi'
import { CopyGlyphButton } from '../../ui'
import { AnsiOutput } from './AnsiOutput'
import { ConversationMarkdown } from './conversationLinks'
import type { CommandOutputEntry } from './conversationProjection'

// eslint-disable-next-line no-control-regex -- the escape byte is what is being looked for
const ANSI_ESCAPE = /\u001b\[/

export function CommandOutputRow({ entry }: { entry: CommandOutputEntry }) {
  const ansi = useMemo(() => (ANSI_ESCAPE.test(entry.output) ? parseAnsi(entry.output) : null), [entry.output])
  // A line the adapter wrote about the command (a `/clear` that started a new
  // conversation) is a remark on the conversation, not output.
  if (entry.note)
    return (
      <p data-command-output-note="" className="pb-6 text-meta text-[color:var(--text-muted)]">
        {entry.output}
      </p>
    )
  return (
    <div className="pb-6">
      <div
        className={`group/command-output rounded-sm border border-[color:var(--border-subtle)] ${
          ansi
            ? 'bg-[color:var(--terminal-bg)] text-[color:var(--terminal-fg)]'
            : 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-default)]'
        }`}
      >
        <div className="flex items-center gap-2 py-1 pl-3 pr-1 font-mono text-meta">
          <span className="min-w-0 flex-1 truncate py-0.5 text-[color:var(--text-subtle)]">
            {entry.command ? `/${entry.command}` : 'Command output'}
          </span>
          <CopyGlyphButton
            text={entry.output}
            label="Copy output"
            size="xs"
            className="opacity-0 group-hover/command-output:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
          />
        </div>
        <div className="overflow-x-auto border-t border-[color:var(--border-subtle)] px-3 py-2">
          {ansi ? (
            <div className="font-mono text-meta leading-relaxed">
              <AnsiOutput lines={ansi} />
            </div>
          ) : (
            <div data-command-output-markdown="" className="min-w-0 break-words">
              <ConversationMarkdown text={entry.output} size="compact" userText />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
