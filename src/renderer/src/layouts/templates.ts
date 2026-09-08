// Re-export shim (MC-2158). The layout templates moved to
// `src/shared/layouts/templates.ts` so main can mint a fully-formed workspace
// with no window open; this keeps every existing renderer import site green.
export {
  AUTOMATIONS_HOST_TEMPLATE,
  DEFAULT_LAYOUT_TEMPLATE,
  EMPTY_CHAT_TEMPLATE,
  LAYOUT_TEMPLATES,
  REVIEWS_HOST_TEMPLATE,
  defaultTemplateForWorkspaceMode,
  resolveHeadlessLayoutTemplate,
} from '../../../shared/layouts/templates'
