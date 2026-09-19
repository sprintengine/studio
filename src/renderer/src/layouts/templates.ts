// Re-export shim. The layout templates moved to
// `src/shared/layouts/templates.ts` so main can mint a fully-formed workspace
// with no window open; this keeps every existing renderer import site green.
export { EMPTY_CHAT_TEMPLATE, LAYOUT_TEMPLATES } from '../../../shared/layouts/templates'
