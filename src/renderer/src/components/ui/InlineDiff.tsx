import { useEffect, useMemo, useState } from 'react'
import { formatHunkHeader } from '../../../../shared/git/hunks'
import { emphasizeChangedWords, type ConversationEdit } from '../../../../shared/conversation/editHunks'
import { loadCodeLanguage, normalizeCodeLanguage } from '../../lib/highlight/codeHighlight'
import { GhostButton } from './Buttons'
import '../../../../../design-system/components/inline-diff/component.css'

export function InlineDiff({ edit, onOpen }: { edit: ConversationEdit; onOpen?: () => void }) {
  const [all, setAll] = useState(false)
  const [highlighted, setHighlighted] = useState<Map<string, { content: string; color?: string }[]>>(new Map())
  const limited = edit.added + edit.removed > 400
  const hunks = limited && !all ? edit.hunks.slice(0, 3) : edit.hunks
  const sourceLines = useMemo(() => edit.hunks.flatMap((hunk) => hunk.lines), [edit.hunks])
  useEffect(() => {
    let cancelled = false
    const language = normalizeCodeLanguage(edit.path.split('.').at(-1))
    if (!language) return
    void loadCodeLanguage(language)
      .then((engine) => {
        const tokens = new Map<string, { content: string; color?: string }[]>()
        for (const line of sourceLines.slice(0, 2000))
          tokens.set(
            line,
            engine.codeToTokensBase(line.slice(1), {
              lang: language,
              theme: 'semantic-code',
              tokenizeTimeLimit: 50,
            })[0],
          )
        if (!cancelled) setHighlighted(tokens)
      })
      .catch(() => {
        /* Diffs remain readable if their grammar cannot load. */
      })
    return () => {
      cancelled = true
    }
  }, [edit.path, sourceLines])
  return (
    <section aria-label={`Changes in ${edit.path}`}>
      <div className="flex items-center gap-2 text-meta">
        <span>
          +{edit.added} −{edit.removed}
        </span>
        {onOpen ? (
          <GhostButton size="inline" onClick={onOpen}>
            Open in diff viewer
          </GhostButton>
        ) : null}
      </div>
      <div className="ds-inline-diff">
        {hunks.map((hunk, hunkIndex) => (
          <div key={hunkIndex}>
            <div className="ds-inline-diff__header">{formatHunkHeader(hunk)}</div>
            {(edit.newFile && !all ? hunk.lines.slice(0, 40) : hunk.lines).map((line, index) => {
              const added = line.startsWith('+'),
                removed = line.startsWith('-')
              const sibling =
                removed && hunk.lines[index + 1]?.startsWith('+')
                  ? hunk.lines[index + 1]
                  : added && hunk.lines[index - 1]?.startsWith('-')
                    ? hunk.lines[index - 1]
                    : undefined
              const emphasis = sibling
                ? emphasizeChangedWords((removed ? line : sibling).slice(1), (added ? line : sibling).slice(1))
                : undefined
              const parts = emphasis ? (added ? emphasis.next : emphasis.old) : undefined
              return (
                <div
                  key={index}
                  className={`ds-inline-diff__line${added ? ' ds-inline-diff__line--added' : removed ? ' ds-inline-diff__line--removed' : ''}`}
                >
                  {line[0]}
                  {parts
                    ? parts.map((part, partIndex) =>
                        part.changed ? (
                          <mark key={partIndex}>{part.text}</mark>
                        ) : (
                          <span key={partIndex}>{part.text}</span>
                        ),
                      )
                    : (highlighted.get(line)?.map((token, tokenIndex) => (
                        <span key={tokenIndex} style={{ color: token.color }}>
                          {token.content}
                        </span>
                      )) ?? line.slice(1))}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {((edit.newFile && edit.added > 40) || limited) && !all ? (
        <GhostButton size="inline" onClick={() => (onOpen ? onOpen() : setAll(true))}>
          Open full diff
        </GhostButton>
      ) : null}
      {edit.limited ? <p>Diff preview exceeded its time limit. Open the full diff to inspect this change.</p> : null}
    </section>
  )
}
