import React, { type JSX } from 'react'

import { ChipButton } from './ChipButton'
import { CloseIconButton, IconButton } from './Buttons'
import { Pager } from './Pager'
import { Switch } from './Switch'
import { Tooltip } from './Tooltip'
import { PauseGlyph, PlayGlyph, StepListGlyph, TourGlyph } from './TourGlyphs'

// The diff tour's band (design-system/components/tour-strip): the tour's name,
// where you are in it, and the few controls that act on the tour and nothing
// else. It takes the step strip's slot above the diff toolbar while a tour
// plays, so the region keeps one band above its own toolbar, not two.

/** How one step reads on the strip's progress edge. */
export type TourProgressMark = 'ahead' | 'visited' | 'current' | 'moved' | 'gone'

export type TourStripProps = {
  title: string
  /** 0-based. */
  index: number
  count: number
  onStep: (index: number) => void
  playing: boolean
  onTogglePlay: () => void
  follow: boolean
  onFollowChange: (follow: boolean) => void
  listOpen: boolean
  onToggleList: () => void
  onClose: () => void
  /** The agent is pointing at another step (`tour.goto` with Follow off). */
  pointer: { index: number; onGo: () => void } | null
  progress: readonly TourProgressMark[]
  /** The keys that step, for the chevrons' tooltip. */
  stepHint?: string
}

export function TourStrip({
  title,
  index,
  count,
  onStep,
  playing,
  onTogglePlay,
  follow,
  onFollowChange,
  listOpen,
  onToggleList,
  onClose,
  pointer,
  progress,
  stepHint = '[ / ]',
}: TourStripProps): JSX.Element {
  const followId = React.useId()
  return (
    <div className="tour-strip relative flex h-control-lg shrink-0 items-center gap-2 bg-[color:var(--bg-surface)] px-3">
      <TourGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />
      <span
        className="min-w-0 truncate text-body font-medium tracking-tight text-[color:var(--text-strong)]"
        title={title}
      >
        {title}
      </span>
      <Pager
        inline
        inlineNoun={count === 1 ? 'step' : 'steps'}
        page={count === 0 ? 0 : index + 1}
        pageCount={count}
        rangeLabel={`Step ${index + 1} of ${count}`}
        stepHint={stepHint}
        ariaLabel="Tour steps"
        onPageChange={(page) => onStep(page - 1)}
      />
      <span className="flex-1" />
      {pointer ? (
        <ChipButton className="shrink-0" onClick={pointer.onGo}>
          Agent points to step {pointer.index + 1} →
        </ChipButton>
      ) : null}
      <Tooltip content={playing ? 'Pause' : 'Play — advance at reading pace'} placement="bottom">
        <IconButton aria-label={playing ? 'Pause tour' : 'Play tour'} pressed={playing} onClick={onTogglePlay}>
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </IconButton>
      </Tooltip>
      <span className="flex shrink-0 items-center gap-1.5">
        <Switch checked={follow} onChange={onFollowChange} ariaLabelledBy={followId} />
        <span id={followId} className="whitespace-nowrap text-meta text-[color:var(--text-muted)]">
          Follow agent
        </span>
      </span>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[color:var(--border-subtle)]" />
      <Tooltip content={listOpen ? 'Hide steps' : 'Show steps'} placement="bottom">
        <IconButton aria-label="Steps" pressed={listOpen} onClick={onToggleList}>
          <StepListGlyph />
        </IconButton>
      </Tooltip>
      <Tooltip content="Leave the tour" placement="bottom">
        <CloseIconButton aria-label="Leave the tour" onClick={onClose} />
      </Tooltip>
      <TourProgress marks={progress} />
    </div>
  )
}

/**
 * The strip's bottom edge, drawn as the tour: one segment per step. It is the
 * band's only rule — where a plain hairline would sit — so progress costs no
 * extra row. Neutral ink throughout; `moved` and `gone` are carried by the step
 * list's glyphs and words, never by a hue here.
 */
export function TourProgress({ marks }: { marks: readonly TourProgressMark[] }): JSX.Element {
  return (
    <div aria-hidden className="tour-progress absolute inset-x-0 bottom-0 flex gap-px">
      {marks.map((mark, position) => (
        <span key={position} className="tour-progress-segment" data-mark={mark} />
      ))}
    </div>
  )
}
