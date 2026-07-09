// Compose the srcDoc for annotate mode. The security invariant that lets us turn
// `allow-scripts` on for this mode: neutralize every author <script> so the only
// code that runs is our injected picker. `allow-same-origin` is never granted,
// so the frame stays an opaque origin regardless. The normal scripts-off preview
// path (MockupPreviewPane) does not use this composer and is untouched.

import { buildAnnotatePickerSource } from './pickerRuntime'

// Matches a <script> start tag and captures its attributes. `[^>]*` stops at the
// first '>', which is correct for the design mockups we render; a '>' inside an
// attribute value is a documented edge (see composeAnnotateSrcDoc note).
const SCRIPT_OPEN_TAG = /<script\b([^>]*)>/gi
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
 * Known edge: a literal '>' inside a script tag's attribute value truncates the
 * match; such a tag is left as-is. Author scripts are the trust surface tested
 * in annotateSrcDoc.test.ts; inline `on*` handlers and `javascript:` URLs remain
 * a residual surface flagged for the security sweep (T14).
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
