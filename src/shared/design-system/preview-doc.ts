// Composing the self-contained document a component preview renders inside.
//
// Component HTML and CSS are THIRD-PARTY CONTENT. They must not restyle app
// chrome, and app tokens must not bleed into them. Both directions are handled
// by rendering each preview in its own sandboxed `<iframe srcDoc={…}>`:
//
//  - a separate document means a component's `body { … }` reaches its own body
//    and nothing else, and our `--text-*` / `--control-*` aliases are simply
//    absent inside it;
//  - the sandbox NEVER carries `allow-scripts`, so nothing in a preview can
//    run. A frame the door has to MEASURE takes `allow-same-origin` and nothing
//    else (`PreviewFrame`'s `sizeToContent`, 2026-09-08 — a specimen sheet has
//    to size itself to its content); every other frame keeps `sandbox=""`,
//    which denies the origin as well;
//  - the meta CSP below is the belt to those braces: `default-src 'none'` with
//    only inline styles and `data:` images/fonts allowed, so nothing can be
//    fetched from disk or network even if the sandbox attribute were dropped by
//    a future edit.
//
// One component per document is deliberate. `build-catalog.mjs` rescopes demo
// styles because the catalog puts every component in ONE page; per-preview
// frames make that unnecessary, which removes a whole class of "the rescoper
// missed a selector" bug rather than reimplementing it.
//
// Bundle format contract: resources/design-system/templates/USAGE.md.

/** The two modes the bundle format fixes; a preview renders in exactly one. */
export type PreviewMode = 'light' | 'dark'

/**
 * Nothing may be fetched: no network, no `file:` reads, no `<script>`. Styles
 * are inline (we compose them), and images/fonts may only be `data:` URIs the
 * reader already inlined.
 */
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/**
 * Strip anything that would reach outside the document.
 *
 * The reader inlines what it can resolve inside the bundle and reports the rest,
 * so by the time markup arrives here a surviving `<script>` or `<link>` is
 * either unresolvable or hostile. Either way it goes — belt to the sandbox and
 * the CSP, so a preview is inert in three independent ways.
 */
export function stripActiveContent(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    // Inline event handlers cannot fire under `sandbox=""`, but leaving them in
    // the markup invites someone to relax the sandbox later and be surprised.
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    // Any remaining OUTBOUND reference. The reader already inlined what it could
    // resolve inside the bundle and reported the rest, and the CSP would refuse
    // these at load — but a document that still CONTAINS a tracker URL is one
    // relaxed attribute away from fetching it. Blank the value, keep the element.
    .replace(
      /\s(src|href|poster|srcset)\s*=\s*("([^"]*)"|'([^']*)')/gi,
      (whole, attribute: string, _quoted: string, double?: string, single?: string) => {
        const value = (double ?? single ?? '').trim()
        if (!value || value.startsWith('#') || value.startsWith('data:')) return whole
        return ` ${attribute}=""`
      },
    )
}

export interface ComposePreviewInput {
  /** The bundle's emitted `:root`/`[data-mode="dark"]` block (emitTokensCss). */
  tokensCss: string
  /** The component's own `component.css`, with bundle-relative refs inlined. */
  componentCss: string
  /** `<style>` blocks lifted from `component.html`, in document order. */
  inlineStyles: readonly string[]
  /** The stage markup to render — one stage for a tile, all of them for detail. */
  bodyHtml: string
  /** Which mode the frame paints; drives the `data-mode` the tokens key off. */
  mode: PreviewMode
  /**
   * What to do with the demo's own prose captions.
   *
   *  - `'none'` (default) — the `<p class="demo-label">` sentences are REMOVED
   *    from the body markup before the document is composed.
   *  - `'as-authored'` — the bundle's markup is passed through untouched.
   *
   * Removed, not restyled (owner ruling 2026-09-08). Every bundled stage opens
   * with a sentence explaining the rows under it; on a specimen sheet that prose
   * is the noise — the rows themselves are the statement, and a caption under
   * each of fifty specimens turns a page of live components into a page of
   * reading. A stylesheet override would leave the text on the page at a
   * quieter size, still read, still pushing the next specimen down. Removing the
   * element is also the only version that is honest about height: the frame's
   * measured height shrinks because the text genuinely is not there.
   *
   * Composition is the right place for it, and the reason it is the DEFAULT is
   * that the door is the only consumer that composes at all — `build-catalog`
   * builds its page a different way and is untouched by this option.
   */
  captions?: 'as-authored' | 'none'
  /**
   * Let the document size itself to its content rather than filling the frame.
   * Tiles centre a single specimen; the detail view stacks stages top-down.
   */
  layout?: 'center' | 'flow'
}

/**
 * Compose a complete, self-contained preview document.
 *
 * Guaranteed of the result: no `<script>`, no external reference of any kind, a
 * `data-mode` on the root so the bundle's own dark overrides apply, and the
 * bundle's tokens ahead of the component's styles so the component wins on
 * specificity ties exactly as it does in its own repo.
 */
export function composePreviewSrcDoc(input: ComposePreviewInput): string {
  const {
    tokensCss,
    componentCss,
    inlineStyles,
    bodyHtml,
    mode,
    layout = 'center',
    captions = 'none',
  } = input
  const styles = [tokensCss, ...inlineStyles, componentCss]
    .map((block) => block.trim())
    .filter(Boolean)
    .map(stripCssImports)
    .join('\n')
  // `safe center` is the whole trick for tiles: a stage SHORTER than the frame
  // is centred, and one TALLER is anchored to the top instead of being centred
  // into a middle slice. Plain `center` clipped both ends, so a tall demo
  // document rendered as a band cut through the middle of two controls — real
  // content, drawn in a way that reads as broken.
  const frame =
    layout === 'center'
      ? `html,body{height:100%}body{display:flex;align-items:safe center;justify-content:safe center;overflow:hidden}`
      : `body{overflow-x:hidden}`
  return `<!doctype html>
<html lang="en" data-mode="${mode}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}" />
<style>
/* The preview surface itself. Transparent so the app's stage colour shows
   through — the app owns the stage, the bundle owns the component. */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
${frame}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:0.01ms !important;animation-iteration-count:1 !important;transition-duration:0.01ms !important;scroll-behavior:auto !important}
}
</style>
<style>
${styles}
</style>
</head>
<body>
${stripActiveContent(captions === 'none' ? stripDemoCaptions(bodyHtml) : bodyHtml)}
</body>
</html>`
}

/**
 * Remove the demo's prose captions from a stage's markup.
 *
 * The bundle format is regular here, which is what makes one expression enough:
 * `demo-label` only ever appears on a `<p>`, one class among others, and never
 * nests another `<p>`. Everything else in the stage is kept exactly as authored
 * — `demo-row`, `demo-grid`, `demo-pane`, and the state names drawn inside the
 * specimens themselves — so the rows still read visually and the states are
 * still legible by shape. Only the sentences about them go.
 */
export function stripDemoCaptions(html: string): string {
  return html.replace(/<p\b[^>]*class="[^"]*\bdemo-label\b[^"]*"[^>]*>[\s\S]*?<\/p\s*>/gi, '')
}

/**
 * Remove `@import` rules from a style block.
 *
 * An `@import` is an external reference the CSP would block anyway, but a
 * blocked import leaves the component silently unstyled. Stripping it here keeps
 * the reader's `unresolvedRefs` the single place that reports "we could not load
 * something", instead of a console error nobody sees.
 */
function stripCssImports(css: string): string {
  return css.replace(/@import\s+[^;]+;/gi, '')
}
