// Mermaid diagrams drawn from a reply's ```mermaid fences.
//
// The renderer is large and almost no conversation needs it, so it is loaded
// the first time a diagram is drawn, never with the app. Its configuration is
// global — `initialize` replaces it for every diagram after — so diagrams are
// drawn one at a time, each with the configuration it was asked for. A
// diagram's SVG is kept per appearance and source, so a settled message that
// re-renders, or scrolls back into view, does not draw it again.
//
// The source is an agent's text, so it is drawn at `securityLevel: 'strict'`
// (labels are sanitized, click handlers and links are refused), and the SVG
// that comes back is sanitized once more before it reaches the page.

type Mermaid = typeof import('mermaid').default
type Purify = typeof import('dompurify').default
type Engine = { mermaid: Mermaid; purify: Purify }

let engine: Promise<Engine> | null = null

function loadEngine(): Promise<Engine> {
  engine ??= Promise.all([import('mermaid'), import('dompurify')]).then(
    ([mermaid, purify]) => ({ mermaid: mermaid.default, purify: purify.default }),
    (error: unknown) => {
      engine = null
      throw error
    },
  )
  return engine
}

export type DiagramResult = { svg: string } | { error: string }

/**
 * The SVG as the page may hold it: SVG and the HTML Mermaid sets inside a
 * `foreignObject` for its labels, with every script, handler and `javascript:`
 * URL taken out.
 */
export function sanitizeDiagramSvg(purify: Purify, svg: string): string {
  return purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  })
}

// ---- The appearance a diagram is drawn in ----------------------------------

/**
 * Which appearance the window is in: the theme and its light or dark mode, as
 * the document root carries them. A diagram is drawn per appearance, since its
 * colours are baked into the SVG.
 */
export function appearanceKey(): string {
  if (typeof document === 'undefined') return ''
  const root = document.documentElement
  return `${root.getAttribute('data-theme') ?? ''}|${root.getAttribute('data-mode') ?? ''}`
}

// One observer for every diagram on screen, there only while one is.
const appearanceListeners = new Set<() => void>()
let appearanceObserver: MutationObserver | null = null

/** Calls `onChange` when the window's appearance changes; returns the unsubscribe. */
export function subscribeAppearance(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined
  appearanceListeners.add(onChange)
  if (!appearanceObserver) {
    appearanceObserver = new MutationObserver(() => {
      for (const listener of appearanceListeners) listener()
    })
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode'],
    })
  }
  return () => {
    appearanceListeners.delete(onChange)
    if (appearanceListeners.size || !appearanceObserver) return
    appearanceObserver.disconnect()
    appearanceObserver = null
  }
}

// Mermaid's `base` theme derives every colour it is not given from the ones it
// is, so these are the roles a diagram draws with, each from the semantic token
// with that meaning: a node is a raised fill on the block's surface, its line
// and label take the border and body ink, edges the quieter ink.
const THEME_TOKENS: Record<string, string> = {
  background: '--sem-color-bg-surface',
  mainBkg: '--sem-color-bg-active',
  primaryColor: '--sem-color-bg-active',
  primaryBorderColor: '--sem-color-border-strong',
  primaryTextColor: '--sem-color-text-default',
  nodeBorder: '--sem-color-border-strong',
  nodeTextColor: '--sem-color-text-default',
  textColor: '--sem-color-text-default',
  titleColor: '--sem-color-text-primary',
  lineColor: '--sem-color-text-muted',
  secondaryColor: '--sem-color-accent-soft',
  tertiaryColor: '--sem-color-bg-hover',
  clusterBkg: '--sem-color-bg-well',
  clusterBorder: '--sem-color-border-default',
  edgeLabelBackground: '--sem-color-bg-surface',
  noteBkgColor: '--sem-color-status-warn-soft',
  noteBorderColor: '--sem-color-border-default',
  noteTextColor: '--sem-color-text-default',
  actorBkg: '--sem-color-bg-active',
  actorBorder: '--sem-color-border-strong',
  actorTextColor: '--sem-color-text-default',
  signalColor: '--sem-color-text-muted',
  signalTextColor: '--sem-color-text-default',
  labelBoxBkgColor: '--sem-color-bg-active',
  labelBoxBorderColor: '--sem-color-border-strong',
  labelTextColor: '--sem-color-text-default',
  loopTextColor: '--sem-color-text-default',
  activationBkgColor: '--sem-color-bg-hover',
  activationBorderColor: '--sem-color-border-strong',
  sequenceNumberColor: '--sem-color-text-on-accent',
  errorBkgColor: '--sem-color-status-danger-soft',
  errorTextColor: '--sem-color-status-danger',
}

// Mermaid computes shades from the colours it is handed, so each has to be
// one its colour library reads: a token written any other way (a mix, a wide
// gamut) is painted once and read back as rgba.
const LEGIBLE_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]*\))$/iu

function colorReader(): (value: string) => string | undefined {
  let probe: CanvasRenderingContext2D | null | undefined
  return (value) => {
    if (!value || LEGIBLE_COLOR.test(value)) return value || undefined
    if (probe === undefined) {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      probe = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (!probe) return undefined
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = 'rgba(0, 0, 0, 0)'
    probe.fillStyle = value
    probe.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = probe.getImageData(0, 0, 1, 1).data
    return alpha ? `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})` : undefined
  }
}

function themeVariables(): Record<string, string | boolean> {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const read = (token: string) => style.getPropertyValue(token).trim()
  const color = colorReader()
  const variables: Record<string, string | boolean> = { darkMode: root.getAttribute('data-mode') === 'dark' }
  for (const [name, token] of Object.entries(THEME_TOKENS)) {
    const value = color(read(token))
    if (value) variables[name] = value
  }
  const font = read('--sem-font-family-ui')
  const size = read('--sem-font-size-body')
  if (font) variables.fontFamily = font
  if (size) variables.fontSize = size
  return variables
}

// ---- Drawing, one at a time --------------------------------------------------

// Bounded, least recently used out: an SVG is tens of kilobytes, and a window
// stays open for days of transcripts.
const MAX_CACHED = 32
const cache = new Map<string, DiagramResult>()
const drawing = new Map<string, Promise<DiagramResult>>()
let queue: Promise<unknown> = Promise.resolve()
let serial = 0

function cacheKey(appearance: string, source: string): string {
  return `${appearance}\0${source}`
}

/** The diagram already drawn for this appearance and source, if there is one. */
export function cachedDiagram(appearance: string, source: string): DiagramResult | undefined {
  const key = cacheKey(appearance, source)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function remember(key: string, result: DiagramResult): void {
  cache.set(key, result)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
}

/**
 * Draws a diagram, after every diagram asked for before it. The same source
 * asked for twice while it is being drawn is drawn once. A source that does
 * not parse resolves to its error — never a rejection — and that answer is
 * kept like a drawing is; a renderer that failed to load is not, so the next
 * diagram asks for it again.
 */
export function drawDiagram(appearance: string, source: string): Promise<DiagramResult> {
  const key = cacheKey(appearance, source)
  const hit = cachedDiagram(appearance, source)
  if (hit) return Promise.resolve(hit)
  const pending = drawing.get(key)
  if (pending) return pending
  const run = queue.then(async () => {
    const loaded = await loadEngine().catch(() => null)
    if (!loaded) return { error: 'The diagram renderer could not be loaded' }
    const result = await render(loaded, source)
    remember(key, result)
    return result
  })
  queue = run.catch(() => undefined)
  drawing.set(key, run)
  void run.finally(() => drawing.delete(key)).catch(() => undefined)
  return run
}

async function render({ mermaid, purify }: Engine, source: string): Promise<DiagramResult> {
  const id = `chat-diagram-${++serial}`
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(),
      // A diagram that does not parse is reported to the block, which shows
      // its source instead; Mermaid must not draw its own error graphic.
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
    })
    // Parse first: a syntax error then throws here, before anything is added
    // to the document to measure.
    await mermaid.parse(source)
    const { svg } = await mermaid.render(id, source)
    return { svg: sanitizeDiagramSvg(purify, svg) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    // The scratch element Mermaid measures in, should a failure leave it behind.
    document.getElementById(`d${id}`)?.remove()
  }
}
