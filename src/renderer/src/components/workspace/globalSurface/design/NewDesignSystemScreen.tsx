import { useMemo } from 'react'

import { composePreviewSrcDoc, type PreviewMode } from '../../../../../../shared/design-system/preview-doc'
import type { DesignSystemBundleView } from '../../../../../../shared/design-system/bundle-view'
import { GhostButton, InlineNotice } from '../../../ui'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import { PreviewFrame } from './PreviewFrame'

// The create path behind the rail's New affordance (item 2005). Owner
// (2026-07-29): "when you click on New Design System, maybe you can start from
// previous designs that you've built."
//
// Build-to-it mockup: backlog/mockups/2026-07-30-design-system-new.html.
//
// **Point at a folder is the primary action**, in the DOOR bar (the surface's
// `bar.actions`, composed by `DesignGlobalSurface`), and it is the one
// accent-filled control on the screen — owner ruling 2026-07-30: "it will
// always just be pointing at a folder at least for now." This screen renders no
// bar of its own: the app strip is the door's one title bar and nothing stacks
// between it and the content (`principles.md` → The door surface).
//
// **No heading over the grid.** With the rejected "bring one in" row cut there is
// one group on screen, and `principles.md` is explicit that a heading must
// separate something from something else. "Start from one you have" would label
// the only thing there.
//
// Deliberately absent, and not to be re-added here: clone-from-GitHub, DTCG
// token-file import, and any marketplace affordance. The token import is the
// right idea eventually — it is the only standardised interchange in this space
// — but it is not this item.

/** Reserved card-specimen height, so the grid cannot jitter as frames mount. */
const CARD_PREVIEW_HEIGHT = 132

export interface NewDesignSystemSource {
  /** The registration this card seeds from, or null for the Empty system card. */
  path: string | null
  name: string
  /** The system's own view, for a card that is a live specimen of itself. */
  view: DesignSystemBundleView | null
}

export function NewDesignSystemScreen({
  sources,
  mode,
  busy,
  error,
  onPointAtFolder,
  onSeedFrom,
}: {
  /** One card per readable library system; the Empty card is added here. */
  sources: readonly NewDesignSystemSource[]
  mode: PreviewMode
  /** The name of the source being created from, while creation is in flight. */
  busy: string | null
  error: string | null
  /** The recovery for a refused folder: pick another. The primary itself lives
   *  in the door bar. */
  onPointAtFolder: () => void
  onSeedFrom: (source: NewDesignSystemSource) => void
}): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* No line of copy over the grid, either: "a design system lives in a Git
          repo you clone" was explanatory text on a surface the owner ruled must
          be self-evident — if a control needs a sentence, redesign the
          control. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-6">
        {error ? (
          // A failure, not a note: the shared error card with its recovery,
          // never red ink alone (`principles.md` → Status is earned).
          <InlineNotice
            tone="error"
            className="mb-4"
            action={
              <GhostButton onClick={onPointAtFolder} disabled={busy !== null}>
                Choose another folder
              </GhostButton>
            }
          >
            {error}
          </InlineNotice>
        ) : null}
        {/* No heading: one group on screen labels nothing. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-5 gap-y-8">
          {sources.map((source) => (
            <StartCard
              key={source.path ?? 'empty'}
              source={source}
              mode={mode}
              busy={busy === source.name}
              disabled={busy !== null}
              onSelect={() => onSeedFrom(source)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One start point, rendered as a live specimen of the system it seeds from.
 *
 * Boxless: the tinted stage is the SYSTEM'S OWN surface colour and nothing wraps
 * it. The card names its system exactly once — inside the specimen, in that
 * system's own face — so there is no caption repeating it beneath.
 */
function StartCard({
  source,
  mode,
  busy,
  disabled,
  onSelect,
}: {
  source: NewDesignSystemSource
  mode: PreviewMode
  busy: boolean
  disabled: boolean
  onSelect: () => void
}): JSX.Element {
  const srcDoc = useMemo(() => (source.view ? cardSpecimen(source.view, mode) : null), [source.view, mode])
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-label={source.path ? `Start from ${source.name}` : 'Start from an empty system'}
      // Hover is a background change only — no scale, no shadow, no border
      // appearing. `rounded-md` is radius.control, one of this view's two radii.
      // Disabled is the button canon (ui/Buttons): opacity step, `not-allowed`,
      // and the hover fill pinned off — `:hover` still matches a disabled
      // button, so without the pin a dead card lit up under the pointer.
      className={`group flex flex-col rounded-md p-1 text-left transition-colors hover:bg-[color:var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent ${FOCUS_RING_CLASS}`}
    >
      {srcDoc ? (
        <PreviewFrame
          height={CARD_PREVIEW_HEIGHT}
          title={`${source.name} specimen`}
          className="pointer-events-none w-full overflow-hidden rounded-md"
          srcDoc={srcDoc}
        />
      ) : (
        <EmptySystemStage />
      )}
      {busy ? (
        <span role="status" className="mt-2 text-meta text-[color:var(--text-muted)]">
          Creating…
        </span>
      ) : null}
    </button>
  )
}

/**
 * The Empty system card.
 *
 * The one card with no specimen to show, because there is no system yet — so it
 * says what it is, in app chrome, rather than borrowing a preview it does not
 * have. Same boxless treatment: a tinted stage, nothing wrapping it.
 */
function EmptySystemStage(): JSX.Element {
  return (
    <div
      style={{ height: CARD_PREVIEW_HEIGHT }}
      className="flex w-full items-center justify-center rounded-md border border-dashed border-[color:var(--border-default)] text-meta text-[color:var(--text-muted)]"
    >
      Empty system
    </div>
  )
}

/**
 * A card's specimen: the system's name in its own face, over its own surface
 * colour, with its palette beneath.
 *
 * Composed with the SAME machinery the canvas uses (`composePreviewSrcDoc` +
 * the emitted token block), so a card and the canvas cannot disagree about what
 * a system looks like, and third-party token values stay inside a sandboxed
 * document rather than reaching app chrome.
 */
function cardSpecimen(view: DesignSystemBundleView, mode: PreviewMode): string {
  const ramp = view.specimen.ramp
    .slice(0, 12)
    .map(
      (swatch) =>
        `<span style="flex:1;background:${escapeAttribute(mode === 'dark' ? swatch.dark : swatch.light)}"></span>`,
    )
    .join('')
  const family = view.specimen.fontFamilyUi
    ? `font-family:${escapeAttribute(view.specimen.fontFamilyUi)};`
    : ''
  return composePreviewSrcDoc({
    tokensCss: view.specimen.tokensCss,
    componentCss: `
      .card { width:100%; height:100%; display:flex; flex-direction:column;
              justify-content:space-between;
              background:var(--sem-color-bg-surface, var(--sem-color-bg-app, transparent));
              color:var(--sem-color-text-default, inherit); padding:14px; }
      .word { ${family} font-size:22px; line-height:1.1; }
      .ramp { display:flex; height:10px; border-radius:3px; overflow:hidden; }
    `,
    inlineStyles: [],
    bodyHtml: `<div class="card"><div class="word">${escapeText(view.identity.name)}</div><div class="ramp">${ramp}</div></div>`,
    mode,
    layout: 'flow',
  })
}

/** Third-party strings never reach markup or a style attribute unescaped. */
function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;',
  )
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/[;{}]/g, '')
}
