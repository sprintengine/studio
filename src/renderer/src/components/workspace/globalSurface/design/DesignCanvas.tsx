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
  DesignSystemTokenView,
} from '../../../../../../shared/design-system/bundle-view'
import { designSystemEntryKey } from '../../../../../../shared/design-system/new-entries'
import {
  InboxRow,
  NewChip,
  Pager,
  Section,
  TabPanel,
  Tabs,
  TabsScroller,
  TruncatedText,
  type TabItem,
} from '../../../ui'
import { PreviewFrame } from './PreviewFrame'

// The Design door's canvas (item 2003) — the heart of the epic. Owner
// (2026-07-29): "I want to see my design system. I want to see what everything
// looks like. I want to see what a list row looks like."
//
// Rebuilt 2026-09-08 to the approved v2 mock-up, on the owner's ruling: **one
// font, and no text but the names.**
//
//  1. **Six tabs, one band.** Colour · Type · Spacing · Components · Patterns ·
//     Glyphs, in the kit's `Tabs` inside a 36px band that owns the hairline (the
//     `GitPanel` idiom exactly). The three token tabs are `foundations` exploded
//     into the families it actually holds; the other three are the manifest's own
//     groups. Nothing stacks between the door bar and this band
//     (`principles.md` → The door surface): the folder path rides the band's
//     trailing edge, and Reveal / Reload ride the door bar.
//  2. **A specimen is three things: the name, the New chip, the demo.** No
//     counts line under a component that is sitting live underneath its own
//     heading, no collapsed spec disclosure, no captions — those are stripped in
//     composition (`preview-doc`'s `captions: 'none'`), not restyled. And no
//     click-into detail view: the stage IS the component, at full size.
//  3. **The token tabs print token paths and nothing else.** The swatch is the
//     hex, the row is drawn at the value, and a reader who needs the string has
//     the path to grep. Hover names what a shape is (`title` + `aria-label`).
//  4. **No boxes and no monospace.** Whitespace groups; the app's one UI face
//     sets every string in this door, including the token paths.
//
// Two radii only (`rounded-sm` = radius.control, `rounded-lg` = radius.shell),
// three type sizes (title / body / meta, with micro collapsing into meta), and
// hover is a background change — never a scale, shadow, or appearing border.

/** The canvas's tabs, in the order the band draws them. */
export type DesignCanvasTabId =
  | 'colour'
  | 'type'
  | 'spacing'
  | 'components'
  | 'patterns'
  | 'glyphs'

/**
 * How many specimens a page of Components or Patterns holds.
 *
 * Eight, because a specimen is a live document: forty-eight of them on one page
 * is forty-eight documents laid out at once, and the pager states where you are
 * in words rather than growing the page until it stops.
 */
export const DESIGN_CANVAS_PAGE_SIZE = 8

/** Reserved heights, corrected by the frame once it has measured its document. */
const COMPONENT_STAGE_RESERVE = 160
const PATTERN_STAGE_RESERVE = 260
const GLYPH_STRIP_RESERVE = 140

const STAGE_CLASS = 'overflow-hidden rounded-lg bg-[color:var(--bg-surface-raised)]'
const PANEL_CLASS = 'px-3 pb-8 pt-2'

export function DesignCanvas({
  view,
  mode,
  newEntries,
  tab,
  onTabChange,
  pages,
  onPageChange,
}: {
  view: DesignSystemBundleView
  mode: PreviewMode
  /**
   * The entry keys that arrived since this person last opened this bundle —
   * `designSystemEntryKey(groupKey, manifestEntry)`, computed by the door.
   *
   * Handed down rather than computed here: the answer depends on a persisted
   * per-machine visit stamp that the canvas has no business reading, and the
   * rail needs the same set to count it.
   */
  newEntries?: ReadonlySet<string>
  /**
   * Which tab is showing, or null while the door has not chosen — the canvas
   * then opens on the components, which is what the door is for.
   *
   * View state, held by the door beside `selectedId` and `search`, never in the
   * URL: a tab is where you are looking, not where you are.
   */
  tab: DesignCanvasTabId | null
  onTabChange: (tab: DesignCanvasTabId) => void
  /** Tab id → 1-based page, for the two paged tabs. Absent means page 1. */
  pages: Readonly<Partial<Record<DesignCanvasTabId, number>>>
  onPageChange: (tab: DesignCanvasTabId, page: number) => void
}): JSX.Element {
  const items = useMemo(() => designCanvasTabs(view), [view])
  const active = resolveDesignCanvasTab(items, tab)
  const idPrefix = 'design-canvas'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One band, and the strip earns it: the tabs on the left, and the folder
          this system lives in clipped from the left-hand end on the right, with
          the full path one hover or focus away. */}
      <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-3">
        <TabsScroller className="flex min-w-0 flex-1 items-end self-stretch">
          <Tabs<DesignCanvasTabId>
            ariaLabel={`${view.identity.name} contents`}
            idPrefix={idPrefix}
            items={items}
            value={active ?? items[0]?.id ?? 'components'}
            onChange={onTabChange}
            borderless
          />
        </TabsScroller>
        <TruncatedText
          as="span"
          text={view.identity.path}
          className="block min-w-0 max-w-[40%] shrink text-meta text-[color:var(--text-muted)]"
        />
      </div>
      {/* What the READER could not do, said once and quietly — never swallowed,
          and never a tinted pill. A token file that half-parsed is why a colour
          looks wrong, and an exhausted asset budget is why a preview looks
          broken; both are the door's to admit. */}
      {view.specimen.problems.length > 0 ? (
        <p className="px-3 pt-2 text-meta text-[color:var(--text-muted)]">
          {view.specimen.problems.length} token
          {view.specimen.problems.length === 1 ? '' : 's'} could not be read
        </p>
      ) : null}
      {view.assetBudgetExhausted ? (
        <p className="px-3 pt-2 text-meta text-[color:var(--text-muted)]">
          Some assets were too large to preview
        </p>
      ) : null}
      {active ? (
        <TabPanel
          idPrefix={idPrefix}
          tabId={active}
          active
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <CanvasPanel
            tab={active}
            view={view}
            mode={mode}
            newEntries={newEntries}
            page={pages[active] ?? 1}
            onPageChange={onPageChange}
          />
        </TabPanel>
      ) : (
        // A readable bundle that declares nothing this door can draw. Said
        // plainly rather than as six empty tabs.
        <p className="px-3 pt-3 text-meta text-[color:var(--text-muted)]">
          This system declares nothing to show yet.
        </p>
      )}
    </div>
  )
}

/**
 * The tabs this bundle has something to put in, in the fixed order.
 *
 * Sections come from the manifest, not from us (the rule this canvas has carried
 * since item 2003): a tab for a group the manifest declares empty would be the
 * door claiming a system has patterns when it has none. The three token tabs ask
 * the same question of the token document — a bundle with no space scale gets no
 * Spacing tab rather than an empty one.
 */
export function designCanvasTabs(view: DesignSystemBundleView): TabItem<DesignCanvasTabId>[] {
  const tokens = tokenFamilies(view)
  const items: TabItem<DesignCanvasTabId>[] = []
  const push = (id: DesignCanvasTabId, label: string, count: number): void => {
    if (count > 0) items.push({ id, label, count })
  }
  push('colour', 'Colour', view.specimen.ramp.length)
  push(
    'type',
    'Type',
    tokens.fontSize.length + tokens.fontWeight.length + tokens.fontLine.length +
      tokens.fontTracking.length,
  )
  push('spacing', 'Spacing', tokens.space.length + tokens.size.length + tokens.radius.length + tokens.shadow.length)
  push('components', 'Components', groupOf(view, 'components')?.count ?? 0)
  push('patterns', 'Patterns', groupOf(view, 'patterns')?.count ?? 0)
  push('glyphs', 'Glyphs', groupOf(view, 'glyphs')?.count ?? 0)
  return items
}

/**
 * Which tab is actually showing: the door's pick when this bundle has it, else
 * the components, else whatever this bundle does have.
 *
 * The fallback matters on every bundle switch — a person on the Patterns tab who
 * selects a system with no patterns must land somewhere real rather than on an
 * empty panel whose tab is not in the strip.
 */
export function resolveDesignCanvasTab(
  items: readonly TabItem<DesignCanvasTabId>[],
  requested: DesignCanvasTabId | null,
): DesignCanvasTabId | null {
  if (requested && items.some((item) => item.id === requested)) return requested
  if (items.some((item) => item.id === 'components')) return 'components'
  return items[0]?.id ?? null
}

function CanvasPanel({
  tab,
  view,
  mode,
  newEntries,
  page,
  onPageChange,
}: {
  tab: DesignCanvasTabId
  view: DesignSystemBundleView
  mode: PreviewMode
  newEntries?: ReadonlySet<string>
  page: number
  onPageChange: (tab: DesignCanvasTabId, page: number) => void
}): JSX.Element {
  switch (tab) {
    case 'colour':
      return <ColourPanel view={view} mode={mode} />
    case 'type':
      return <TypePanel view={view} />
    case 'spacing':
      return <SpacingPanel view={view} mode={mode} />
    case 'glyphs':
      return <GlyphStrip view={view} mode={mode} />
    case 'patterns':
      return (
        <PatternsPanel
          view={view}
          mode={mode}
          newEntries={newEntries}
          page={page}
          onPageChange={onPageChange}
        />
      )
    case 'components':
    default:
      return (
        <ComponentsPanel
          view={view}
          mode={mode}
          newEntries={newEntries}
          page={page}
          onPageChange={onPageChange}
        />
      )
  }
}

// ── Components and patterns ──────────────────────────────────────────────────

function ComponentsPanel({
  view,
  mode,
  newEntries,
  page,
  onPageChange,
}: {
  view: DesignSystemBundleView
  mode: PreviewMode
  newEntries?: ReadonlySet<string>
  page: number
  onPageChange: (tab: DesignCanvasTabId, page: number) => void
}): JSX.Element {
  const group = groupOf(view, 'components')
  const rendered = useMemo(
    () =>
      group
        ? view.components.filter((component) => matchesEntry(group.entries, component.name))
        : view.components,
    [group, view.components],
  )
  const range = pageWindow(rendered.length, page)
  return (
    <div className={PANEL_CLASS}>
      {rendered.slice(range.from, range.to).map((component) => (
        <ComponentSpecimen
          key={component.name}
          component={component}
          tokensCss={view.specimen.tokensCss}
          mode={mode}
          isNew={isNewEntry(newEntries, 'components', group?.entries ?? [], component.name)}
        />
      ))}
      {/* Declared but not on disk: named, never silently missing. */}
      <MissingEntries
        declared={group?.entries ?? []}
        present={rendered.map((component) => component.name)}
      />
      <SpecimenPager
        tab="components"
        noun="Components"
        systemName={view.identity.name}
        total={rendered.length}
        page={page}
        onPageChange={onPageChange}
      />
    </div>
  )
}

/** One specimen, and only three things: the name, the New chip, the demo. */
function ComponentSpecimen({
  component,
  tokensCss,
  mode,
  isNew,
}: {
  component: DesignSystemComponentView
  tokensCss: string
  mode: PreviewMode
  isNew: boolean
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
        // The sheet stacks stages top-down and the frame measures what it gets;
        // centring inside a fixed box is what the retired tile grid did.
        layout: 'flow',
      }),
    [tokensCss, component.css, component.inlineStyles, stage?.html, mode],
  )
  return (
    <Section
      title={component.name}
      action={isNew ? <NewChip /> : undefined}
      inset={false}
    >
      {stage ? (
        <PreviewFrame
          height={COMPONENT_STAGE_RESERVE}
          sizeToContent
          title={`${component.name} — ${mode}`}
          className={STAGE_CLASS}
          srcDoc={srcDoc}
        />
      ) : (
        // A component whose demo document is empty: said plainly, never a
        // placeholder graphic pretending to be a rendering.
        <p className="text-meta text-[color:var(--text-muted)]">No preview in this component</p>
      )}
      {component.unresolvedRefs.length > 0 ? (
        <p className="text-meta text-[color:var(--text-muted)]">
          {component.unresolvedRefs.length} reference
          {component.unresolvedRefs.length === 1 ? '' : 's'} could not be loaded
        </p>
      ) : null}
    </Section>
  )
}

function PatternsPanel({
  view,
  mode,
  newEntries,
  page,
  onPageChange,
}: {
  view: DesignSystemBundleView
  mode: PreviewMode
  newEntries?: ReadonlySet<string>
  page: number
  onPageChange: (tab: DesignCanvasTabId, page: number) => void
}): JSX.Element {
  const group = groupOf(view, 'patterns')
  const rendered = useMemo(
    () =>
      group ? view.patterns.filter((pattern) => matchesEntry(group.entries, pattern.name)) : view.patterns,
    [group, view.patterns],
  )
  const range = pageWindow(rendered.length, page)
  return (
    <div className={PANEL_CLASS}>
      {rendered.slice(range.from, range.to).map((pattern) => (
        <Section
          key={pattern.name}
          title={pattern.name}
          action={
            isNewEntry(newEntries, 'patterns', group?.entries ?? [], pattern.name) ? <NewChip /> : undefined
          }
          inset={false}
        >
          <PreviewFrame
            height={PATTERN_STAGE_RESERVE}
            sizeToContent
            title={`${pattern.name} — ${mode}`}
            className={STAGE_CLASS}
            srcDoc={composePreviewSrcDoc({
              tokensCss: view.specimen.tokensCss,
              componentCss: '',
              inlineStyles: pattern.inlineStyles,
              bodyHtml: pattern.html,
              mode,
              layout: 'flow',
            })}
          />
        </Section>
      ))}
      <MissingEntries
        declared={group?.entries ?? []}
        present={rendered.map((pattern) => pattern.name)}
      />
      <SpecimenPager
        tab="patterns"
        noun="Patterns"
        systemName={view.identity.name}
        total={rendered.length}
        page={page}
        onPageChange={onPageChange}
      />
    </div>
  )
}

/** The foot of a paged tab: the position in words, and the numbered pages. */
function SpecimenPager({
  tab,
  noun,
  systemName,
  total,
  page,
  onPageChange,
}: {
  tab: DesignCanvasTabId
  noun: string
  systemName: string
  total: number
  page: number
  onPageChange: (tab: DesignCanvasTabId, page: number) => void
}): JSX.Element | null {
  if (total === 0) return null
  const range = pageWindow(total, page)
  return (
    <Pager
      page={range.page}
      pageCount={range.pageCount}
      rangeLabel={`Showing ${range.from + 1}–${range.to} of ${total}`}
      onPageChange={(next) => onPageChange(tab, next)}
      ariaLabel={`${noun} in ${systemName}`}
      className="px-3"
    />
  )
}

/** The slice one page shows, with the page clamped to what exists. */
export function pageWindow(
  total: number,
  page: number,
): { page: number; pageCount: number; from: number; to: number } {
  const pageCount = Math.max(1, Math.ceil(total / DESIGN_CANVAS_PAGE_SIZE))
  // A page number outlives the list it was taken on — a search, a reload, a
  // bundle that lost a component — so it is clamped rather than trusted.
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount)
  const from = (clamped - 1) * DESIGN_CANVAS_PAGE_SIZE
  return { page: clamped, pageCount, from, to: Math.min(total, from + DESIGN_CANVAS_PAGE_SIZE) }
}

// ── Glyphs ───────────────────────────────────────────────────────────────────

/**
 * All the glyphs at once, in one wrapping strip of equal cells.
 *
 * A glyph is a 16-grid drawing that means one thing; a page that gives each one
 * a heading, a card and a caption spends a screen and a half saying twelve
 * words. The strip is the honest shape: the marks side by side at the ramp's
 * `lg` step inside `control-md` cells (an interactive glyph pads out to a
 * control-sized hit area and never grows to fill it), and the name carried by
 * `title` + `aria-label` so a pointer or a reader can ask which is which without
 * it being printed.
 *
 * ONE composed document, not one per glyph: the strip is a single preview, so it
 * is still the product's own frame and still inert in the same ways.
 */
function GlyphStrip({ view, mode }: { view: DesignSystemBundleView; mode: PreviewMode }): JSX.Element {
  const group = groupOf(view, 'glyphs')
  const rendered = useMemo(
    () =>
      group ? view.glyphs.filter((glyph) => matchesEntry(group.entries, glyph.name)) : view.glyphs,
    [group, view.glyphs],
  )
  const srcDoc = useMemo(() => {
    const cells = rendered
      .map(
        (glyph) =>
          `<span class="glyph-cell" role="img" title="${escapeAttribute(glyph.name)}" aria-label="${escapeAttribute(glyph.name)}">${glyph.svg}</span>`,
      )
      .join('\n')
    const css = [
      'body{padding:var(--sem-space-2xl)}',
      '.glyph-strip{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sem-space-3xl)}',
      '.glyph-cell{display:inline-flex;align-items:center;justify-content:center;',
      'width:var(--sem-size-control-md);height:var(--sem-size-control-md);',
      'color:var(--sem-color-text-default)}',
      '.glyph-cell svg{display:block;width:var(--sem-icon-size-lg);height:var(--sem-icon-size-lg)}',
    ].join('')
    return composePreviewSrcDoc({
      tokensCss: view.specimen.tokensCss,
      componentCss: css,
      inlineStyles: [],
      bodyHtml: `<div class="glyph-strip">\n${cells}\n</div>`,
      mode,
      layout: 'flow',
    })
  }, [rendered, view.specimen.tokensCss, mode])
  return (
    <div className={PANEL_CLASS}>
      <PreviewFrame
        height={GLYPH_STRIP_RESERVE}
        sizeToContent
        title={`Glyphs — ${mode}`}
        className={STAGE_CLASS}
        srcDoc={srcDoc}
      />
      <MissingEntries declared={group?.entries ?? []} present={rendered.map((glyph) => glyph.name)} />
    </div>
  )
}

/** A glyph name lands in an attribute of a document we compose. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── The token tabs ───────────────────────────────────────────────────────────

/**
 * The colour ramp as rows: the swatch, and the token path.
 *
 * The hex is not printed. The swatch IS the hex, and a reader who needs the
 * string has the token name to grep; the swatch carries `title` and `aria-label`
 * set to the path, so hovering a colour names it and a screen reader gets the
 * same string the row prints.
 */
function ColourPanel({ view, mode }: { view: DesignSystemBundleView; mode: PreviewMode }): JSX.Element {
  const families = useMemo(() => {
    const out: Array<{ name: string; swatches: DesignSystemBundleView['specimen']['ramp'] }> = []
    for (const swatch of view.specimen.ramp) {
      const name = rampFamily(swatch.path)
      const found = out.find((family) => family.name === name)
      if (found) found.swatches.push(swatch)
      else out.push({ name, swatches: [swatch] })
    }
    return out
  }, [view.specimen.ramp])
  return (
    <div className={PANEL_CLASS}>
      {families.map((family) => (
        <Section key={family.name} title={family.name} count={family.swatches.length} inset={false}>
          {family.swatches.map((swatch) => (
            <InboxRow
              key={swatch.path}
              leading={
                <span
                  role="img"
                  aria-label={swatch.path}
                  title={swatch.path}
                  className="block size-icon-lg shrink-0 rounded-sm border border-[color:var(--border-subtle)]"
                  // The previewed system's own colours, validated as colours by
                  // the token resolver before they reach a style attribute.
                  style={{ background: mode === 'dark' ? swatch.dark : swatch.light }}
                />
              }
              title={swatch.path}
            />
          ))}
        </Section>
      ))}
    </div>
  )
}

/**
 * Which family a ramp entry belongs to: `ref.color.ink-950` → "ink",
 * `ref.color.green.600` → "green".
 *
 * Both spellings are in the wild and neither is the door's to correct.
 */
function rampFamily(path: string): string {
  const parts = path.split('.')
  const leaf = parts[parts.length - 1] ?? path
  if (/^\d+$/.test(leaf)) return parts[parts.length - 2] ?? leaf
  const stripped = leaf.replace(/-\d+$/, '')
  return stripped.length > 0 ? stripped : leaf
}

/**
 * The type tab: each row sets ITS OWN token name in ITS OWN step.
 *
 * A type ramp needs something set in it, and the only string on a page that
 * prints no prose is the token's own name. There is no specimen sentence and no
 * `sem.font.family` section — the door has exactly one face now, so a family
 * specimen would show the reader the same thing twice.
 */
function TypePanel({ view }: { view: DesignSystemBundleView }): JSX.Element {
  const tokens = tokenFamilies(view)
  return (
    <div className={PANEL_CLASS}>
      <TokenSection title="Size" tokens={tokens.fontSize}>
        {(token, value) => (
          <span title={token.path} style={{ fontSize: value, lineHeight: 1.4 }}>
            {token.path}
          </span>
        )}
      </TokenSection>
      <TokenSection title="Weight" tokens={tokens.fontWeight}>
        {(token, value) => (
          <span title={token.path} style={{ fontWeight: value }}>
            {token.path}
          </span>
        )}
      </TokenSection>
      <TokenSection title="Line height" tokens={tokens.fontLine}>
        {(token, value) => (
          // Leading only exists BETWEEN lines, so the specimen has to be more
          // than one: the name three times, wrapped, and nothing else.
          <span
            title={token.path}
            className="block max-w-[24ch] whitespace-normal"
            style={{ lineHeight: value }}
          >
            {`${token.path} ${token.path} ${token.path}`}
          </span>
        )}
      </TokenSection>
      <TokenSection title="Tracking" tokens={tokens.fontTracking}>
        {(token, value) => (
          <span title={token.path} style={{ letterSpacing: value }}>
            {token.path}
          </span>
        )}
      </TokenSection>
    </div>
  )
}

/**
 * The spacing tab: the shape drawn at the token's value, and the path.
 *
 * The value is not printed — the square IS the value. Every drawing carries the
 * path as `title` and `aria-label`, so pointing at one names it.
 */
function SpacingPanel({ view, mode }: { view: DesignSystemBundleView; mode: PreviewMode }): JSX.Element {
  const tokens = tokenFamilies(view)
  const draw = mode === 'dark' ? 'dark' : 'light'
  return (
    <div className={PANEL_CLASS}>
      <Section title="Space" count={tokens.space.length} inset={false}>
        {tokens.space.map((token) => (
          <InboxRow
            key={token.path}
            leading={
              <span
                role="img"
                aria-label={token.path}
                title={token.path}
                className="block shrink-0 bg-[color:var(--accent-primary-soft)]"
                style={{ width: token[draw], height: token[draw] }}
              />
            }
            title={token.path}
          />
        ))}
      </Section>
      <Section title="Size" count={tokens.size.length} inset={false}>
        {tokens.size.map((token) => (
          <InboxRow
            key={token.path}
            leading={
              <span
                role="img"
                aria-label={token.path}
                title={token.path}
                className="block w-16 shrink-0 rounded-sm bg-[color:var(--bg-selected)]"
                style={{ height: token[draw] }}
              />
            }
            title={token.path}
          />
        ))}
      </Section>
      <Section title="Radius" count={tokens.radius.length} inset={false}>
        {tokens.radius.map((token) => (
          <InboxRow
            key={token.path}
            leading={
              <span
                role="img"
                aria-label={token.path}
                title={token.path}
                className="block size-control-sm shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]"
                style={{ borderRadius: token[draw] }}
              />
            }
            title={token.path}
          />
        ))}
      </Section>
      <Section title="Shadow" count={tokens.shadow.length} inset={false}>
        {tokens.shadow.map((token) => (
          <InboxRow
            key={token.path}
            leading={
              <span
                role="img"
                aria-label={token.path}
                title={token.path}
                className="block size-control-sm shrink-0 rounded-sm bg-[color:var(--bg-surface-raised)]"
                // The previewed system's own elevation, in the mode the app is
                // in — a light shadow drawn on a dark ground is not the token.
                style={{ boxShadow: token[draw] }}
              />
            }
            title={token.path}
          />
        ))}
      </Section>
    </div>
  )
}

/** A token family as rows, each drawn by the caller in its own step. */
function TokenSection({
  title,
  tokens,
  children,
}: {
  title: string
  tokens: readonly DesignSystemTokenView[]
  children: (token: DesignSystemTokenView, value: string) => JSX.Element
}): JSX.Element | null {
  if (tokens.length === 0) return null
  return (
    <Section title={title} count={tokens.length} inset={false}>
      {tokens.map((token) => (
        <InboxRow key={token.path} hideDot title={children(token, token.light)} />
      ))}
    </Section>
  )
}

// ── Shared derivations ───────────────────────────────────────────────────────

/**
 * The token families the reader resolved.
 *
 * Defensive about absence rather than about SHAPE: a bundle read by an older
 * main process (or a fixture written before the families existed) carries none,
 * and the tabs should be missing rather than the door throwing.
 */
function tokenFamilies(view: DesignSystemBundleView): DesignSystemBundleView['specimen']['tokens'] {
  const tokens = view.specimen.tokens as DesignSystemBundleView['specimen']['tokens'] | undefined
  return {
    fontSize: tokens?.fontSize ?? [],
    fontWeight: tokens?.fontWeight ?? [],
    fontLine: tokens?.fontLine ?? [],
    fontTracking: tokens?.fontTracking ?? [],
    space: tokens?.space ?? [],
    size: tokens?.size ?? [],
    radius: tokens?.radius ?? [],
    shadow: tokens?.shadow ?? [],
  }
}

function groupOf(view: DesignSystemBundleView, key: string): DesignSystemGroupView | null {
  return view.groups.find((group) => group.key === key) ?? null
}

/**
 * Which manifest string a rendered item was declared as.
 *
 * The view's names are stems the reader derived; the manifest may have declared
 * a bare stem or a bundle-relative path, and the entry KEY is built from what the
 * manifest actually said. Going back through the declaration rather than
 * re-deriving a key from the stem is what keeps the door's markers addressed the
 * same way the reader dated them.
 */
function declaredEntryFor(entries: readonly string[], name: string): string | null {
  return entries.find((entry) => entry === name || stemOf(entry) === name) ?? null
}

function stemOf(entry: string): string {
  return (entry.split('/').pop() ?? entry).replace(/\.[a-z]+$/i, '')
}

/** Is this rendered item one that arrived since the last visit? */
function isNewEntry(
  newEntries: ReadonlySet<string> | undefined,
  groupKey: string,
  entries: readonly string[],
  name: string,
): boolean {
  if (!newEntries || newEntries.size === 0) return false
  const declared = declaredEntryFor(entries, name)
  return declared !== null && newEntries.has(designSystemEntryKey(groupKey, declared))
}

// Manifest entries come in two forms — bare stems and bundle-relative paths
// ("patterns/context-rail.html") — while view names are always the stem the
// reader derives. Compare stems, or a path-form manifest empties its section.
function matchesEntry(entries: readonly string[], name: string): boolean {
  return entries.some((entry) => entry === name || stemOf(entry) === name)
}

function MissingEntries({
  declared,
  present,
}: {
  declared: readonly string[]
  present: readonly string[]
}): JSX.Element | null {
  const missing = declared.filter((entry) => !present.includes(stemOf(entry)) && !present.includes(entry))
  if (missing.length === 0) return null
  return (
    <p className="px-3 pt-3 text-meta text-[color:var(--text-muted)]">
      {missing.length} declared but not on disk: {missing.join(', ')}
    </p>
  )
}
