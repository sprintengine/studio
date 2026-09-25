import React, { useEffect, useRef, useState, type JSX } from 'react'

import { GhostButton, IconButton, OutlineButton } from './Buttons'
import { NextDifferenceGlyph, PreviousDifferenceGlyph } from './GitActionGlyphs'
import { InlineNotice } from './InlineNotice'
import { Input } from './Input'
import { MicroChip } from './DefaultChip'
import { WorkingEdge } from './WorkingEdge'

// One step of a diff tour, said beside the code it is about
// (design-system/components/tour-callout). In the diff it lives in a Monaco
// view zone under the step's last line — the code below moves down to make
// room and nothing is covered. For a file with no text to point into (binary,
// too large) the same callout stands alone as a card.

export type TourCalloutAskState =
  | { kind: 'idle' }
  /** Waiting for the author to finish its turn. */
  | { kind: 'queued'; askId: string }
  /** Typed in; the author is working on it. */
  | { kind: 'answering'; agentName: string | null }
  | { kind: 'answered'; agentName: string | null }
  | { kind: 'author-gone' }
  | { kind: 'failed'; message: string }

export type TourCalloutProps = {
  /** 0-based. */
  index: number
  count: number
  title: string
  kind: 'explain' | 'context' | 'caveat'
  /** The rendered markdown body. */
  body: React.ReactNode
  /** `path L40–43 (new)` — where the step is, in the diff's own terms. */
  location: string
  status: 'ok' | 'moved' | 'gone'
  /** What the step pointed at when it was written; shown when it no longer can be. */
  excerpt: readonly string[]
  visible: boolean
  variant?: 'zone' | 'card'
  onPrev?: () => void
  onNext?: () => void
  ask: TourCalloutAskState
  onAsk: (question: string) => void
  onCancelQueued: (askId: string) => void
  onAskNewAgent: (question: string) => void
  /** Pointer over the callout or focus in its field: Play holds while true. */
  onHoldChange?: (hold: boolean) => void
  /** The callout's height, for the view zone it sits in. */
  onResize?: (height: number) => void
}

const KIND_LABEL: Record<TourCalloutProps['kind'], string | null> = {
  explain: null,
  context: 'Context',
  caveat: 'Caveat',
}

export function TourCallout({
  index,
  count,
  title,
  kind,
  body,
  location,
  status,
  excerpt,
  visible,
  variant = 'zone',
  onPrev,
  onNext,
  ask,
  onAsk,
  onCancelQueued,
  onAskNewAgent,
  onHoldChange,
  onResize,
}: TourCalloutProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [question, setQuestion] = useState('')
  // The last question sent, kept for "Ask a new agent" when the author has gone.
  const [lastQuestion, setLastQuestion] = useState('')
  const hoverRef = useRef(false)
  const focusRef = useRef(false)

  useEffect(() => {
    const node = rootRef.current
    if (!node || !onResize) return
    const report = (): void => onResize(node.getBoundingClientRect().height)
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [onResize])

  const hold = (): void => onHoldChange?.(hoverRef.current || focusRef.current)
  const submit = (): void => {
    const text = question.trim()
    if (!text) return
    setLastQuestion(text)
    setQuestion('')
    onAsk(text)
  }
  const kindLabel = KIND_LABEL[kind]
  const answering = ask.kind === 'answering'

  return (
    <div
      ref={rootRef}
      className="tour-callout-frame"
      data-variant={variant}
      data-visible={visible ? 'true' : 'false'}
      onMouseEnter={() => {
        hoverRef.current = true
        hold()
      }}
      onMouseLeave={() => {
        hoverRef.current = false
        hold()
      }}
    >
      <section
        className="tour-callout relative"
        data-kind={kind}
        aria-label={`Step ${index + 1} of ${count}: ${title}`}
      >
        <header className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-meta tabular-nums text-[color:var(--text-subtle)]">
            {index + 1}/{count}
          </span>
          <h3 className="min-w-0 flex-1 truncate text-body font-medium tracking-tight text-[color:var(--text-strong)]">
            {title}
          </h3>
          {kindLabel ? <MicroChip>{kindLabel}</MicroChip> : null}
          {onPrev || onNext ? (
            <span className="flex shrink-0 items-center">
              <IconButton aria-label="Previous step" size="xs" disabled={!onPrev} onClick={onPrev}>
                <PreviousDifferenceGlyph className="icon-xs" />
              </IconButton>
              <IconButton aria-label="Next step" size="xs" disabled={!onNext} onClick={onNext}>
                <NextDifferenceGlyph className="icon-xs" />
              </IconButton>
            </span>
          ) : null}
        </header>
        <p className="mt-0.5 truncate font-mono text-micro tracking-wide text-[color:var(--text-subtle)]">{location}</p>

        {status !== 'ok' ? (
          <InlineNotice
            tone="warn"
            className="mt-2"
            title={
              status === 'moved' ? 'This code changed after the tour was written' : 'This file is no longer in the diff'
            }
          >
            {excerpt.length > 0 ? <TourExcerpt lines={excerpt} /> : null}
          </InlineNotice>
        ) : null}

        <div className="tour-callout-body mt-2">{body}</div>

        <div className="mt-3 flex items-center gap-2">
          {ask.kind === 'author-gone' ? (
            <>
              <span className="min-w-0 flex-1 text-meta text-[color:var(--text-muted)]">
                The agent that wrote this tour has exited.
              </span>
              <OutlineButton size="sm" onClick={() => onAskNewAgent(question.trim() || lastQuestion)}>
                Ask a new agent
              </OutlineButton>
            </>
          ) : ask.kind === 'queued' ? (
            <>
              <span className="min-w-0 flex-1 text-meta text-[color:var(--text-muted)]" role="status">
                Queued · sends when the agent is ready
              </span>
              <GhostButton size="sm" onClick={() => onCancelQueued(ask.askId)}>
                Cancel
              </GhostButton>
            </>
          ) : (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <Input
                size="sm"
                value={question}
                placeholder={answering ? 'Ask a follow-up…' : 'Ask about this…'}
                aria-label={`Ask about step ${index + 1}`}
                onChange={(event) => setQuestion(event.target.value)}
                onFocus={() => {
                  focusRef.current = true
                  hold()
                }}
                onBlur={() => {
                  focusRef.current = false
                  hold()
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setQuestion('')
                    event.currentTarget.blur()
                  }
                }}
              />
              <OutlineButton size="sm" type="submit" disabled={!question.trim()}>
                Ask
              </OutlineButton>
            </form>
          )}
        </div>
        {ask.kind === 'answering' || ask.kind === 'answered' || ask.kind === 'failed' ? (
          <p className="mt-1.5 text-meta text-[color:var(--text-muted)]">
            {ask.kind === 'failed' ? (
              ask.message
            ) : ask.kind === 'answering' ? (
              <>Asked — {ask.agentName ?? 'the agent'} is answering in its terminal.</>
            ) : (
              <>{ask.agentName ?? 'The agent'} answered in its terminal.</>
            )}
          </p>
        ) : null}
        {answering ? <WorkingEdge label="The agent is answering" /> : null}
      </section>
    </div>
  )
}

/** The lines a step pointed at, as the agent saw them. */
function TourExcerpt({ lines }: { lines: readonly string[] }): JSX.Element {
  return (
    <pre className="tour-excerpt mt-1.5 max-h-40 overflow-auto font-mono text-micro leading-[1.5]">
      {lines.map((line, position) => (
        <span
          key={position}
          className="tour-excerpt-line"
          data-sign={line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'}
        >
          {line.slice(1) || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}
