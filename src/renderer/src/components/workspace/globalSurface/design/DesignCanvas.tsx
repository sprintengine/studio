import { useMemo } from 'react'

import {
  composePreviewSrcDoc,
  type PreviewMode,
} from '../../../../../../shared/design-system/preview-doc'
import { representativeStage } from '../../../../../../shared/design-system/bundle-parse'
import type {
  DesignSystemBundleView,
  DesignSystemComponentView,
  DesignSystemGroupView,
} from '../../../../../../shared/design-system/bundle-view'
import { GhostButton } from '../../../ui'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import { PreviewFrame } from './PreviewFrame'

// The Design door's canvas (item 2003) — the heart of the epic. Owner
// (2026-07-29): "I want to see my design system. I want to see what everything
// looks like. I want to see what a list row looks like."
//
// Build-to-it mockup: backlog/mockups/2026-07-30-design-system-canvas.html.
//
// Three rules the mockup and `principles.md` fix, easy to lose in an edit:
//
//  1. **No boxes.** A border around every component is chrome competing with the
//     thing it frames, and components carry their own edges. Whitespace groups;
//     the name sits beneath; a quiet hover background is the hit target.
//  2. **The specimen has no container and the name appears exactly once** — here,
//     in the system's own display face. The folder path lives in the chrome bar.
//  3. **Sections come from the manifest, not from us.** One per declared group,
//     in manifest order, with its count. No hard-coded taxonomy.
//
// Two radii only (`rounded-md` = radius.control, `rounded-lg` = radius.overlay),
// three type sizes (title / body / meta, with micro collapsing into meta), and
// hover is a background change — never a scale, shadow, or appearing border.

/** Reserved preview heights. Tiles are uniform so the grid cannot jitter. */
const TILE_PREVIEW_HEIGHT = 132
const GLYPH_PREVIEW_HEIGHT = 64
const PATTERN_PREVIEW_HEIGHT = 220
const DETAIL_STAGE_HEIGHT = 260

export function DesignCanvas({
  view,
  mode,
  openComponent,
  onOpenComponent,
  onCloseComponent,
  onReload,
  reloading,
}: {
  view: DesignSystemBundleView
  mode: PreviewMode
  /** The component whose variants are open, or null for the overview. */
  openComponent: string | null
  onOpenComponent: (name: string) => void
  onCloseComponent: () => void
  onReload: () => void
  reloading: boolean
}): JSX.Element {
  const component = openComponent
    ? (view.components.find((entry) => entry.name === openComponent) ?? null)
    : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CanvasBar path={view.identity.path} onReload={onReload} reloading={reloading} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {component ? (
          <ComponentDetail
            component={component}
            specimenCss={view.specimen.tokensCss}
            mode={mode}
            onBack={onCloseComponent}
          />
        ) : (
          <BundleOverview view={view} mode={mode} onOpenComponent={onOpenComponent} />
        )}
      </div>
    </div>
  )
}

/**
 * The canvas chrome bar: the folder, and the two actions that are about it.
 *
 * Deliberately NOT here: Release, version history, an upstream-behind count, a
 * lint or regenerate affordance. The system is a folder in a repo the user
 * manages with git, and linting is the author's gate, not a viewer's.
 */
function CanvasBar({
  path,
  onReload,
  reloading,
}: {
  path: string
  onReload: () => void
  reloading: boolean
}): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-subtle)] px-6 py-2">
      <span
        title={path}
        className="min-w-0 flex-1 truncate font-mono text-meta text-[color:var(--text-subtle)]"
      >
        {path}
      </span>
      <GhostButton onClick={() => void window.api.showItemInFolder(path)}>Reveal</GhostButton>
      <GhostButton onClick={onReload} disabled={reloading}>
        {reloading ? 'Reloading…' : 'Reload'}
      </GhostButton>
    </div>
  )
}

function BundleOverview({
  view,
  mode,
  onOpenComponent,
}: {
  view: DesignSystemBundleView
  mode: PreviewMode
  onOpenComponent: (name: string) => void
}): JSX.Element {
  return (
    <div className="px-6 pb-10 pt-6">
      <Specimen view={view} mode={mode} />
      {view.specimen.problems.length > 0 ? (
        <QuietNote>
          {view.specimen.problems.length} token{view.specimen.problems.length === 1 ? '' : 's'} could
          not be read
        </QuietNote>
      ) : null}
      {view.assetBudgetExhausted ? (
        <QuietNote>Some assets were too large to preview</QuietNote>
      ) : null}
      {view.groups.map((group) => (
        <Section key={group.key} group={group} view={view} mode={mode} onOpenComponent={onOpenComponent} />
      ))}
    </div>
  )
}

/**
 * The specimen: the system's name in its own face, and its palette as one bar.
 *
 * That is all. No container (`principles.md`: group with space and a heading
 * before reaching for one), no "Inter / JetBrains Mono · 12 components" line —
 * every one of those facts is visible below, and a count shown twice is a count
 * that can appear to disagree with itself.
 */
function Specimen({ view, mode }: { view: DesignSystemBundleView; mode: PreviewMode }): JSX.Element {
  const { specimen, identity } = view
  return (
    <section aria-label={`${identity.name} specimen`}>
      <h2
        className="truncate text-[length:2rem] leading-tight text-[color:var(--text-strong)]"
        // A specimen set in OUR font is not a specimen. The previewed system's
        // face is content; app chrome stays on the two families we ship. A bundle
        // declaring none falls back here and must still be legible.
        style={specimen.fontFamilyUi ? { fontFamily: specimen.fontFamilyUi } : undefined}
      >
        {identity.name}
      </h2>
      {specimen.ramp.length > 0 ? (
        <div
          role="img"
          aria-label={`${identity.name} colour ramp, ${specimen.ramp.length} colours`}
          className="mt-4 flex h-8 overflow-hidden rounded-md"
        >
          {specimen.ramp.map((swatch) => (
            <span
              key={swatch.path}
              title={`${swatch.path} · ${mode === 'dark' ? swatch.dark : swatch.light}`}
              className="flex-1"
              // The previewed system's own colours, validated as colours by the
              // token resolver before they reach a style attribute.
              style={{ background: mode === 'dark' ? swatch.dark : swatch.light }}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

/** One manifest-declared group, with its count and the tiles it holds. */
function Section({
  group,
  view,
  mode,
  onOpenComponent,
}: {
  group: DesignSystemGroupView
  view: DesignSystemBundleView
  mode: PreviewMode
  onOpenComponent: (name: string) => void
}): JSX.Element {
  return (
    <section aria-labelledby={`design-group-${group.key}`} className="mt-9">
      <div className="mb-3 flex items-baseline gap-2">
        {/* Sentence case, derived from the manifest key. */}
        <h3
          id={`design-group-${group.key}`}
          className="text-body font-semibold text-[color:var(--text-strong)]"
        >
          {group.label}
        </h3>
        <span className="font-mono text-meta tabular-nums text-[color:var(--text-disabled)]">
          {group.count}
        </span>
      </div>
      <GroupBody group={group} view={view} mode={mode} onOpenComponent={onOpenComponent} />
    </section>
  )
}

function GroupBody({
  group,
  view,
  mode,
  onOpenComponent,
}: {
  group: DesignSystemGroupView
  view: DesignSystemBundleView
  mode: PreviewMode
  onOpenComponent: (name: string) => void
}): JSX.Element {
  if (group.key === 'components') {
    const rendered = view.components.filter((component) => group.entries.includes(component.name))
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-5 gap-y-7">
        {rendered.map((component) => (
          <ComponentTile
            key={component.name}
            component={component}
            tokensCss={view.specimen.tokensCss}
            mode={mode}
            onOpen={() => onOpenComponent(component.name)}
          />
        ))}
        {/* Declared but not on disk: named, never silently missing. */}
        <MissingEntries declared={group.entries} present={rendered.map((entry) => entry.name)} />
      </div>
    )
  }
  if (group.key === 'patterns') {
    const rendered = view.patterns.filter((pattern) => matchesEntry(group.entries, pattern.name))
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-5 gap-y-7">
        {rendered.map((pattern) => (
          <figure key={pattern.name} className="m-0">
            <PreviewFrame
              height={PATTERN_PREVIEW_HEIGHT}
              title={`${pattern.name} pattern preview`}
              className="overflow-hidden rounded-lg bg-[color:var(--bg-surface-raised)]"
              srcDoc={composePreviewSrcDoc({
                tokensCss: view.specimen.tokensCss,
                componentCss: '',
                inlineStyles: pattern.inlineStyles,
                bodyHtml: pattern.html,
                mode,
                layout: 'flow',
              })}
            />
            <figcaption className="mt-2 truncate text-meta text-[color:var(--text-default)]">
              {pattern.name}
            </figcaption>
          </figure>
        ))}
      </div>
    )
  }
  if (group.key === 'glyphs') {
    const rendered = view.glyphs.filter((glyph) => matchesEntry(group.entries, glyph.name))
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-x-3 gap-y-5">
        {rendered.map((glyph) => (
          <figure key={glyph.name} className="m-0">
            <PreviewFrame
              height={GLYPH_PREVIEW_HEIGHT}
              title={`${glyph.name} glyph`}
              className="overflow-hidden rounded-md transition-colors hover:bg-[color:var(--bg-hover)]"
              srcDoc={composePreviewSrcDoc({
                tokensCss: view.specimen.tokensCss,
                componentCss:
                  'svg{width:24px;height:24px;color:var(--sem-color-text-default,currentColor)}',
                inlineStyles: [],
                bodyHtml: glyph.svg,
                mode,
              })}
            />
            <figcaption className="mt-1 truncate text-center text-meta text-[color:var(--text-muted)]">
              {glyph.name}
            </figcaption>
          </figure>
        ))}
      </div>
    )
  }
  // Foundations, assets, and any group a bundle declares that we did not
  // anticipate: the manifest's entries, named. We render what the system says it
  // has rather than inventing a viewer for a shape we have never seen.
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-5 gap-y-2">
      {group.entries.map((entry) => (
        <li key={entry} className="truncate font-mono text-meta text-[color:var(--text-muted)]">
          {entry}
        </li>
      ))}
    </ul>
  )
}

function matchesEntry(entries: readonly string[], name: string): boolean {
  return entries.some((entry) => entry === name || entry.replace(/\.[a-z]+$/i, '') === name)
}

function MissingEntries({
  declared,
  present,
}: {
  declared: readonly string[]
  present: readonly string[]
}): JSX.Element | null {
  const missing = declared.filter((entry) => !present.includes(entry))
  if (missing.length === 0) return null
  return (
    <p className="col-span-full text-meta text-[color:var(--text-muted)]">
      {missing.length} declared but not on disk: {missing.join(', ')}
    </p>
  )
}

/**
 * One component tile: its real rendered appearance, no border, with a hover
 * background as the hit target.
 *
 * The tile shows ONE representative stage — the one matching the app's mode — and
 * the variant/state count beneath is the affordance that says there is more.
 */
function ComponentTile({
  component,
  tokensCss,
  mode,
  onOpen,
}: {
  component: DesignSystemComponentView
  tokensCss: string
  mode: PreviewMode
  onOpen: () => void
}): JSX.Element {
  const stage = representativeStage(component.stages, mode)
  const srcDoc = useMemo(
    () =>
      composePreviewSrcDoc({
        tokensCss,
        componentCss: component.css,
        inlineStyles: component.inlineStyles,
        bodyHtml: stage?.html ?? '',
        mode,
      }),
    [tokensCss, component.css, component.inlineStyles, stage?.html, mode],
  )
  const count = countLabel(component)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={count ? `${component.name} — ${count}` : component.name}
      // No border: whitespace does the grouping, and hover is a background
      // change only — no scale, no shadow, no border appearing and shifting the
      // grid. `rounded-md` is radius.control, one of this view's two radii.
      className={`group flex flex-col rounded-md p-2 text-left transition-colors hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
    >
      {stage ? (
        <PreviewFrame
          height={TILE_PREVIEW_HEIGHT}
          title={`${component.name} preview`}
          className="pointer-events-none w-full overflow-hidden rounded-md"
          srcDoc={srcDoc}
        />
      ) : (
        // A component whose demo document is empty: said plainly, never a
        // placeholder graphic pretending to be a rendering.
        <div
          style={{ height: TILE_PREVIEW_HEIGHT }}
          className="flex items-center justify-center text-meta text-[color:var(--text-muted)]"
        >
          No preview in this component
        </div>
      )}
      <span className="mt-2 truncate text-body text-[color:var(--text-strong)]">
        {component.name}
      </span>
      {count ? <span className="truncate text-meta text-[color:var(--text-muted)]">{count}</span> : null}
      {component.unresolvedRefs.length > 0 ? (
        <span className="truncate text-meta text-[color:var(--text-muted)]">
          {component.unresolvedRefs.length} reference
          {component.unresolvedRefs.length === 1 ? '' : 's'} could not be loaded
        </span>
      ) : null}
    </button>
  )
}

/**
 * "3 variants · 4 states", from `component.md`'s own sections.
 *
 * Null when the doc declares neither: the bundle format has no variant MARKUP
 * contract, so a number we could not read is a number we do not show.
 */
function countLabel(component: DesignSystemComponentView): string | null {
  const parts: string[] = []
  if (component.variantCount !== null) {
    parts.push(`${component.variantCount} variant${component.variantCount === 1 ? '' : 's'}`)
  }
  if (component.stateCount !== null) {
    parts.push(`${component.stateCount} state${component.stateCount === 1 ? '' : 's'}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * A component opened: every stage the author wrote, labelled, then its
 * `component.md` sections as authored.
 *
 * The five headings are fixed and test-enforced by the bundle format, so they are
 * rendered, never summarised.
 */
function ComponentDetail({
  component,
  specimenCss,
  mode,
  onBack,
}: {
  component: DesignSystemComponentView
  specimenCss: string
  mode: PreviewMode
  onBack: () => void
}): JSX.Element {
  const count = countLabel(component)
  return (
    <div className="px-6 pb-10 pt-4">
      <div className="mb-4 flex items-baseline gap-3">
        <GhostButton onClick={onBack}>← All components</GhostButton>
        <h2 className="truncate text-title font-semibold text-[color:var(--text-strong)]">
          {component.name}
        </h2>
        {count ? (
          <span className="shrink-0 text-meta text-[color:var(--text-muted)]">{count}</span>
        ) : null}
      </div>

      {component.stages.length > 0 ? (
        <div className="flex flex-col gap-6">
          {component.stages.map((stage, index) => (
            <figure key={`${stage.mode ?? 'stage'}-${index}`} className="m-0">
              <PreviewFrame
                height={DETAIL_STAGE_HEIGHT}
                title={`${component.name} — ${stage.mode ?? `stage ${index + 1}`}`}
                className="overflow-hidden rounded-lg bg-[color:var(--bg-surface-raised)]"
                srcDoc={composePreviewSrcDoc({
                  tokensCss: specimenCss,
                  componentCss: component.css,
                  inlineStyles: component.inlineStyles,
                  bodyHtml: stage.html,
                  mode: stage.mode === 'dark' ? 'dark' : stage.mode === 'light' ? 'light' : mode,
                  layout: 'flow',
                })}
              />
              <figcaption className="mt-1.5 text-meta text-[color:var(--text-muted)]">
                {stage.mode ?? `Stage ${index + 1}`}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="text-meta text-[color:var(--text-muted)]">
          This component ships no demo document.
        </p>
      )}

      {component.doc ? (
        <div className="mt-9 flex max-w-[80ch] flex-col gap-5">
          {(
            [
              ['Anatomy', component.doc.anatomy],
              ['Variants', component.doc.variants],
              ['States', component.doc.states],
              ['Usage', component.doc.usage],
              ['Accessibility', component.doc.accessibility],
            ] as const
          )
            .filter(([, body]) => body.trim().length > 0)
            .map(([heading, body]) => (
              <section key={heading}>
                <h3 className="text-body font-semibold text-[color:var(--text-strong)]">{heading}</h3>
                {/* As authored: the door renders the author's prose verbatim and
                    never summarises it. Plain text, so markdown source shows as
                    written rather than being half-rendered. */}
                <p className="mt-1 whitespace-pre-wrap text-meta leading-5 text-[color:var(--text-default)]">
                  {body}
                </p>
              </section>
            ))}
        </div>
      ) : null}
    </div>
  )
}

/** A quiet, non-blocking note. Never a tinted pill — those are reject-on-sight. */
function QuietNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="mt-3 text-meta text-[color:var(--text-muted)]">{children}</p>
}
