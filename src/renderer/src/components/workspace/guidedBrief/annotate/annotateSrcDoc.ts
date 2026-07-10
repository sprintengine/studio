// Compose the srcDoc for annotate mode. The LOAD-BEARING security control is
// that `allow-same-origin` is never granted, so the frame is always an opaque
// origin and any author code that does run cannot reach the parent DOM, app
// cookies, storage, or same-origin backends. Neutralizing author <script> tags
// is defense-in-depth on top of that, not the boundary: it removes the common
// script path, but inline `on*` handlers and `javascript:` URLs are NOT stripped
// and still execute under `allow-scripts` (same as the pre-existing
// interactive-demo toggle, which runs raw author scripts under this same
// sandbox). See composeAnnotateSrcDoc for the residual surface and T14's
// security review. The normal scripts-off preview path (MockupPreviewPane) does
// not use this composer and is untouched.

import { buildAnnotatePickerSource } from './pickerRuntime'

// Matches a <script> start tag and captures its attributes. The attribute body
// is quote-aware — `"[^"]*"|'[^']*'` consume a quoted value whole, so a literal
// '>' *inside* an attribute value no longer truncates the match and leave the
// tail of the real tag (with its content) outside neutralization. That truncation
// was a confirmed bypass (T14): `<script a=">payload//">` matched only `<script a=">`,
// and the rewrite produced a *typeless* — therefore executable — inline script.
// The alternatives are first-char-disjoint (`"`, `'`, else non-`>`), so the star
// cannot backtrack catastrophically.
const SCRIPT_OPEN_TAG = /<script\b((?:"[^"]*"|'[^']*'|[^>])*)>/gi
const TYPE_ATTR = /\s+type\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const CLOSING_BODY = /<\/body\s*>/i

/**
 * Rewrite every author `<script>` open tag to `type="text/plain"` so the browser
 * parses its contents as inert text instead of executing them — covers inline
 * scripts (become dead text) and external `src` scripts (never fetched/run).
 * Existing `type` attributes are stripped first so ours is authoritative.
 */
export function neutralizeAuthorScripts(html: string): string {
  return html.replace(SCRIPT_OPEN_TAG, (_match, attrs: string) => {
    const withoutType = attrs.replace(TYPE_ATTR, '')
    return `<script${withoutType} type="text/plain" data-annotate-neutralized="true">`
  })
}

/**
 * Build the annotate-mode srcDoc: author scripts neutralized, then our picker
 * injected as the sole executable script (before `</body>`, else appended).
 * Author-script neutralization happens before injection, so our own script is
 * never rewritten. Callers must still sandbox the frame with `allow-scripts`
 * and never `allow-same-origin`.
 *
 * Author `<script>` tags are neutralized even when an attribute value contains a
 * literal '>' (the quote-aware SCRIPT_OPEN_TAG; regression-tested against the
 * confirmed bypass in annotateSrcDoc.test.ts). Neutralization is defense-in-depth,
 * not the trust boundary: inline `on*` handlers and `javascript:` URLs still run
 * under `allow-scripts`, so the boundary that actually contains author code is the
 * sandbox — opaque origin, never `allow-same-origin`, no popups/top-nav/forms
 * (T14 security review). Any code that does run is confined to this frame.
 */
export function composeAnnotateSrcDoc(html: string): string {
  const neutralized = neutralizeAuthorScripts(html)
  const picker = `<script data-annotate-picker="true">\n${buildAnnotatePickerSource()}\n</script>`
  if (CLOSING_BODY.test(neutralized)) {
    // Function replacer, not a `$&` string: minified picker source can contain
    // `$` sequences that String.replace would otherwise interpret.
    return neutralized.replace(CLOSING_BODY, (closingBody) => `${picker}${closingBody}`)
  }
  return `${neutralized}${picker}`
}
