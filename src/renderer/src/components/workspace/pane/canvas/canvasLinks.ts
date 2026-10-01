/**
 * What clicking a link on a board does.
 *
 * Left to itself, the editor opens a link it judges "local" in the window it
 * is drawn in, and it judges by substring: a link containing this window's
 * origin counts. A packaged app's origin is `file://`, so
 * `https://example.com/?file://` counted, and clicking it turned the app's own
 * window into that page — with the app's bridge to the machine still attached.
 * A board can come from a repository or be written by an agent, so its links
 * are not the person's own words. Every click is decided here instead, and the
 * editor's default never runs:
 *
 * - a link to a shape on this board scrolls to it;
 * - an http or https link goes to the system browser, through the same check
 *   every other opened link passes (`window:open-external`);
 * - anything else (`file:`, `mailto:`, a custom scheme) is refused.
 */
export type CanvasLinkAction = { kind: 'element' } | { kind: 'external'; url: string } | { kind: 'refused' }

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

export function canvasLinkAction(link: string, isElementLink: (link: string) => boolean): CanvasLinkAction {
  if (isElementLink(link)) return { kind: 'element' }
  let protocol: string
  try {
    protocol = new URL(link).protocol
  } catch {
    return { kind: 'refused' }
  }
  return EXTERNAL_PROTOCOLS.has(protocol) ? { kind: 'external', url: link } : { kind: 'refused' }
}
