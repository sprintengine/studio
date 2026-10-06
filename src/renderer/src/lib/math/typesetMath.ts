import type { KatexOptions } from 'katex'

// Math in a reply, set with KaTeX. The typesetter and its stylesheet (whose
// fonts are most of its weight) are loaded the first time a formula is drawn,
// never with the app: most conversations hold no math at all. The fonts are
// the package's own files, bundled beside the stylesheet, so a formula draws
// the same offline.

type Katex = typeof import('katex').default

let katex: Katex | null = null
let loading: Promise<Katex> | null = null
const listeners = new Set<() => void>()

export function loadedTypesetter(): Katex | null {
  return katex
}

export function loadTypesetter(): Promise<Katex> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    ([module]) => {
      katex = module.default
      for (const listener of listeners) listener()
      return katex
    },
    (error: unknown) => {
      // A chunk that failed to load is asked for again by the next formula,
      // rather than leaving every later one as source for the session.
      loading = null
      throw error
    },
  )
  return loading
}

/** Called once the typesetter has loaded; returns the unsubscribe. */
export function onTypesetterLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type TypesetMath = { html: string } | { error: string }

// The text is an agent's, so nothing in it may reach outside the formula:
// `trust: false` refuses `\href`, `\url`, `\includegraphics` and raw HTML, and
// with it KaTeX's output is only its own markup around escaped text, which is
// what makes it safe to set as HTML. `maxExpand` bounds macro expansion so a
// self-referencing `\def` fails instead of hanging the renderer, and
// `strict: 'ignore'` keeps LaTeX-compatibility notes out of the console.
const OPTIONS: KatexOptions = {
  throwOnError: true,
  trust: false,
  strict: 'ignore',
  maxExpand: 1000,
  maxSize: 20,
  output: 'htmlAndMathml',
}

// A transcript repeats its formulas on every re-render of a settled message
// and on every token of the one streaming beside them, so each is set once.
// Bounded, least recently used out.
const MAX_CACHED = 300
const cache = new Map<string, TypesetMath>()

export function typesetMath(engine: Katex, tex: string, display: boolean): TypesetMath {
  const key = `${display ? 'D' : 'I'}\0${tex}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  let result: TypesetMath
  try {
    result = { html: engine.renderToString(tex, { ...OPTIONS, displayMode: display }) }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) }
  }
  cache.set(key, result)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return result
}
