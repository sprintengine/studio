import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { HtmlPreviewCard, htmlArtifactFrameSandbox, TruncatedText } from '../../ui'
import type { DesignArtifactIndex } from './designArtifacts'
import {
  buildComponentGalleryModel,
  componentSectionCountLabel,
  galleryComponentTitle,
  type GalleryComponent,
  type GalleryFoundation,
  type GalleryGlyph,
} from './componentGallery'

// Live component gallery (MC-1509): the design-system studio's default preview.
// A scrollable grid of every bundle component, each card a small live render,
// filling in as the designer works. It re-derives from the run-scoped design
// index (which already re-collects on `useDesignerSession`'s design-system
// watch/poll) — no watcher or IPC of its own — and keys each card by path+mtime
// so only changed cards re-render. Clicking any card opens that file's
// single-file preview (File mode); the grid stays one toolbar click away.

type Props = {
  designArtifacts: DesignArtifactIndex
  /** Opens a bundle file's single-file preview (switches the studio to File mode). */
  onOpenFile: (relativePath: string) => void
}

// Cards past this many mount their live iframe on scroll (IntersectionObserver),
// since each render is an iframe. Small bundles never reach it — this is a guard.
const EAGER_CARD_LIMIT = 12

type RovingProps = {
  tabIndex: number
  onFocus: () => void
  buttonRef: (element: HTMLButtonElement | null) => void
}

// One-shot file reads cached by `path::mtime`. A key is read at most once; when a
// file changes its mtime key changes, so a fresh key triggers a fresh read while
// unchanged files stay cached. Reuses the existing readfile IPC — no new watcher.
function useFileContents(requests: Array<{ key: string; absolutePath: string }>): Map<string, string> {
  const [contents, setContents] = useState<Map<string, string>>(new Map())
  const requestKey = requests.map((request) => request.key).join('|')

  useEffect(() => {
    let cancelled = false
    const missing = requests.filter((request) => !contents.has(request.key))
    if (missing.length === 0) return
    void Promise.all(
      missing.map(async (request): Promise<readonly [string, string]> => {
        try {
          return [request.key, await window.api.readfile(request.absolutePath)] as const
        } catch {
          return [request.key, ''] as const
        }
      }),
    ).then((pairs) => {
      if (cancelled) return
      setContents((previous) => {
        // Rebuild from the CURRENT request set (+ the fresh reads) so keys
        // orphaned by an mtime bump or a deleted file are evicted — otherwise a
        // long editing session accumulates every superseded file body forever.
        const next = new Map<string, string>()
        for (const request of requests) {
          const existing = previous.get(request.key)
          if (existing !== undefined) next.set(request.key, existing)
        }
        for (const [key, value] of pairs) next.set(key, value)
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // requestKey captures the set of keys; contents re-runs the guard after a set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, contents])

  return contents
}

export function ComponentGalleryPane({ designArtifacts, onOpenFile }: Props) {
  const model = useMemo(() => buildComponentGalleryModel(designArtifacts), [designArtifacts])

  // Title reads (component.md) + glyph reads (svg), cached by path+mtime.
  const contentRequests = useMemo(() => {
    const requests: Array<{ key: string; absolutePath: string }> = []
    for (const component of model.components) {
      if (component.mdKey && component.mdAbsolutePath) {
        requests.push({ key: component.mdKey, absolutePath: component.mdAbsolutePath })
      }
    }
    for (const glyph of model.glyphs) {
      requests.push({ key: glyph.key, absolutePath: glyph.absolutePath })
    }
    return requests
  }, [model])
  const fileContents = useFileContents(contentRequests)

  const titleFor = (component: GalleryComponent): string =>
    galleryComponentTitle(component, component.mdKey ? fileContents.get(component.mdKey) : undefined)

  // Glyph SVGs paint in an isolated sandboxed frame, so the app's CSS variables
  // do not cross into them — resolve the real muted-text token here and inject
  // it as a concrete color so currentColor strokes match the live theme. Re-read
  // on model change (poll cadence) so a theme toggle reflects within a tick.
  const [glyphColor, setGlyphColor] = useState('')
  useEffect(() => {
    if (typeof document === 'undefined') return
    setGlyphColor(getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim())
  }, [model])

  // Roving focus over every interactive cell in visual order: ready component
  // cards, then glyphs, then foundations. Building cards are non-interactive and
  // stay out of the sequence. Arrow/Home/End move; Enter/Space (native button)
  // opens.
  const rovingKeys = useMemo(() => {
    const keys: string[] = []
    for (const component of model.components) {
      if (component.state === 'ready') keys.push(`component:${component.dirRelativePath}`)
    }
    for (const glyph of model.glyphs) keys.push(`glyph:${glyph.relativePath}`)
    for (const foundation of model.foundations) keys.push(`foundation:${foundation.id}`)
    return keys
  }, [model])
  const rovingIndexByKey = useMemo(() => {
    const map = new Map<string, number>()
    rovingKeys.forEach((key, index) => map.set(key, index))
    return map
  }, [rovingKeys])

  const cellRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusIndex, setFocusIndex] = useState(0)
  const activeIndex = Math.min(focusIndex, Math.max(0, rovingKeys.length - 1))

  const focusCell = (next: number) => {
    const clamped = Math.max(0, Math.min(rovingKeys.length - 1, next))
    setFocusIndex(clamped)
    cellRefs.current[clamped]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        focusCell(activeIndex + 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        focusCell(activeIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        focusCell(0)
        break
      case 'End':
        event.preventDefault()
        focusCell(rovingKeys.length - 1)
        break
      default:
        break
    }
  }

  const rovingPropsFor = (key: string): RovingProps => {
    const index = rovingIndexByKey.get(key) ?? -1
    return {
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setFocusIndex(index),
      buttonRef: (element) => {
        if (index >= 0) cellRefs.current[index] = element
      },
    }
  }

  if (model.isEmpty) {
    return (
      <GallerySurface>
        <EmptyGallery />
      </GallerySurface>
    )
  }

  let readyPosition = 0
  return (
    <GallerySurface>
      <div
        role="group"
        aria-label="Design system gallery"
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto p-4"
      >
        {model.components.length > 0 ? (
          <GallerySection title="Components" count={componentSectionCountLabel(model)}>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
              {model.components.map((component) => {
                if (component.state !== 'ready' || !component.htmlAbsolutePath || !component.htmlRelativePath) {
                  return <BuildingCard key={component.dirRelativePath} title={component.fallbackTitle} path={component.dirRelativePath} />
                }
                const eager = readyPosition < EAGER_CARD_LIMIT
                readyPosition += 1
                const htmlRelativePath = component.htmlRelativePath
                return (
                  <ComponentGalleryCard
                    key={component.dirRelativePath}
                    component={component}
                    title={titleFor(component)}
                    eager={eager}
                    roving={rovingPropsFor(`component:${component.dirRelativePath}`)}
                    onOpen={() => onOpenFile(htmlRelativePath)}
                  />
                )
              })}
            </div>
          </GallerySection>
        ) : null}

        {model.glyphs.length > 0 ? (
          <GallerySection title="Glyphs" count={`${model.glyphs.length}`}>
            <div className="flex flex-wrap gap-2.5">
              {model.glyphs.map((glyph) => (
                <GlyphCell
                  key={glyph.relativePath}
                  glyph={glyph}
                  svg={fileContents.get(glyph.key)}
                  color={glyphColor}
                  roving={rovingPropsFor(`glyph:${glyph.relativePath}`)}
                  onOpen={() => onOpenFile(glyph.relativePath)}
                />
              ))}
            </div>
          </GallerySection>
        ) : null}

        {model.foundations.length > 0 ? (
          <GallerySection title="Foundations" count={`${model.foundations.length}`}>
            <div className="flex flex-wrap gap-3">
              {model.foundations.map((foundation) => (
                <FoundationCard
                  key={foundation.id}
                  foundation={foundation}
                  roving={rovingPropsFor(`foundation:${foundation.id}`)}
                  onOpen={() => onOpenFile(foundation.relativePath)}
                />
              ))}
            </div>
          </GallerySection>
        ) : null}
      </div>
    </GallerySurface>
  )
}

function GallerySurface({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      {children}
    </div>
  )
}

function GallerySection({
  title,
  count,
  children,
}: {
  title: string
  count: string
  children: ReactNode
}) {
  return (
    <section className="mb-5 last:mb-0">
      <header className="flex items-baseline justify-between px-0.5 pb-2">
        <span className="text-[11px] font-semibold text-[color:var(--text-strong)]">{title}</span>
        <span className="text-[11px] tabular-nums text-[color:var(--text-subtle)]">{count}</span>
      </header>
      {children}
    </section>
  )
}

// A ready component card. The shared HtmlPreviewCard carries the render + click;
// the iframe mounts on scroll past the eager limit (a focusable, clickable
// placeholder holds its grid slot until then, so keyboard order is stable).
function ComponentGalleryCard({
  component,
  title,
  eager,
  roving,
  onOpen,
}: {
  component: GalleryComponent
  title: string
  eager: boolean
  roving: RovingProps
  onOpen: () => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(eager)

  useEffect(() => {
    if (inView) return
    const element = wrapperRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [inView])

  return (
    <div ref={wrapperRef} className="min-w-0">
      {inView ? (
        <HtmlPreviewCard
          key={component.renderKey}
          absolutePath={component.htmlAbsolutePath as string}
          relativePath={component.htmlRelativePath as string}
          title={title}
          onOpen={onOpen}
          tabIndex={roving.tabIndex}
          onFocus={roving.onFocus}
          buttonRef={roving.buttonRef}
        />
      ) : (
        <PlaceholderCard
          title={title}
          relativePath={component.htmlRelativePath as string}
          roving={roving}
          onOpen={onOpen}
        />
      )}
    </div>
  )
}

function PlaceholderCard({
  title,
  relativePath,
  roving,
  onOpen,
}: {
  title: string
  relativePath: string
  roving: RovingProps
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      ref={roving.buttonRef}
      tabIndex={roving.tabIndex}
      onFocus={roving.onFocus}
      onClick={onOpen}
      aria-label={title}
      className="
        flex w-full flex-col overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] text-left
        transition-colors hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)]
        focus-visible:focus-ring
      "
    >
      <span
        aria-hidden="true"
        className="h-[108px] border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
      />
      <span className="flex flex-col gap-0.5 px-3 py-2">
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">{title}</span>
        <TruncatedText
          as="span"
          text={relativePath}
          className="font-mono text-micro text-[color:var(--text-subtle)]"
        />
      </span>
    </button>
  )
}

// A component directory that exists but has no component.html yet — shown in
// place so the user watches components appear. Non-interactive (nothing to open).
function BuildingCard({ title, path }: { title: string; path: string }) {
  return (
    <div
      role="status"
      aria-label={`${title} is being built`}
      className="flex flex-col overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]"
    >
      <span className="flex h-[108px] flex-col items-center justify-center gap-2 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[color:var(--border-default)] border-t-[color:var(--accent-primary)] motion-reduce:animate-none"
        />
        <span className="text-micro text-[color:var(--text-subtle)]">Building {title}…</span>
      </span>
      <span className="flex flex-col gap-0.5 px-3 py-2">
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">{title}</span>
        <TruncatedText
          as="span"
          text={path}
          className="font-mono text-micro text-[color:var(--text-subtle)]"
        />
      </span>
    </div>
  )
}

// Glyph cell: the SVG rendered in a scripts-off sandboxed iframe (same policy as
// every generated-HTML preview — an author SVG never runs on our origin). Opens
// the svg file on click.
function GlyphCell({
  glyph,
  svg,
  color,
  roving,
  onOpen,
}: {
  glyph: GalleryGlyph
  svg: string | undefined
  color: string
  roving: RovingProps
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      ref={roving.buttonRef}
      tabIndex={roving.tabIndex}
      onFocus={roving.onFocus}
      onClick={onOpen}
      aria-label={`${glyph.name} glyph`}
      className="
        grid h-16 w-16 place-items-center overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]
        transition-colors hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)]
        focus-visible:focus-ring
      "
    >
      {svg ? (
        <iframe
          title=""
          tabIndex={-1}
          aria-hidden="true"
          srcDoc={glyphSrcDoc(svg, color)}
          sandbox={htmlArtifactFrameSandbox(false)}
          className="pointer-events-none h-8 w-8 border-0 bg-transparent"
        />
      ) : (
        <span aria-hidden="true" className="h-6 w-6 rounded-sm bg-[color:var(--bg-hover)]" />
      )}
    </button>
  )
}

function glyphSrcDoc(svg: string, color: string): string {
  // Center the glyph and give it the resolved muted-text color so currentColor
  // strokes/fills theme correctly; scripts are off via the sandbox, so this
  // frame only ever paints the SVG.
  const colorRule = color ? `body{color:${color}}` : ''
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:transparent}${colorRule}svg{width:22px;height:22px;display:block}</style>${svg}`
}

function FoundationCard({
  foundation,
  roving,
  onOpen,
}: {
  foundation: GalleryFoundation
  roving: RovingProps
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      ref={roving.buttonRef}
      tabIndex={roving.tabIndex}
      onFocus={roving.onFocus}
      onClick={onOpen}
      className="
        flex min-w-0 max-w-[280px] flex-1 basis-56 flex-col gap-1 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2.5 text-left
        transition-colors hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)]
        focus-visible:focus-ring
      "
    >
      <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">{foundation.title}</span>
      <TruncatedText
        as="span"
        text={foundation.relativePath}
        className="font-mono text-micro text-[color:var(--text-subtle)]"
      />
    </button>
  )
}

// The designed empty state: no components yet, so the studio names where the
// designer begins rather than showing a void.
function EmptyGallery() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span aria-hidden="true" className="flex gap-2">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-10 w-14 rounded-sm border border-dashed border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]"
          />
        ))}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-[12.5px] font-semibold text-[color:var(--text-strong)]">
          No components yet
        </span>
        <span className="max-w-[360px] text-[11.5px] leading-5 text-[color:var(--text-muted)]">
          The designer starts with your tokens and principles — components appear here as each one is
          built.
        </span>
      </span>
    </div>
  )
}
