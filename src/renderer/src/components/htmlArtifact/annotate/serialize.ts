// Sink serialization for annotate batches (MC-1468 part 3). Pure text
// composition over MockupAnnotation[]: a host of HtmlArtifactFrame calls this
// to format a submitted batch for its own feedback channel — today that is
// sprint request-changes (SprintEngineBoardPanel). The frame itself never
// imports this module: where a batch goes, and in what shape, is host-side only
// (MC-1468 decision 2). A second sink for the Design Wizard's designer chat
// lived here until that feature was deleted (2026-09-08).

import type { MockupAnnotation } from './types'

function annotationCount(count: number): string {
  return `${count} pinned note${count === 1 ? '' : 's'}`
}

// Composer messages and snippet excerpts may carry newlines; inside a block
// (or a single-line PTY message) they must stay one line each.
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * One structured block per pin: the selector the agent mechanically locates,
 * the snippet excerpt as the human/agent-readable fallback for when the
 * selector orphans after a revision, and the reviewer's instruction.
 */
function annotationBlock(annotation: MockupAnnotation, index: number): string {
  return [
    `${index + 1}. Element: ${annotation.selector}`,
    `   Snippet: ${inline(annotation.snippet)}`,
    `   Change: ${annotation.message.trim()}`,
  ].join('\n')
}

/**
 * Sink A — sprint review. The batch as structured blocks that PRE-FILL the
 * request-changes dialog (never bypass it): the reviewer can still add overall
 * framing before submitting, and the submitted feedback rides the existing
 * request-changes channel onto the sprint record — no sidecar persistence.
 */
export function sprintAnnotationFeedback(
  relativePath: string,
  annotations: readonly MockupAnnotation[],
): string {
  return [
    `Annotated mockup review of ${relativePath} — ${annotationCount(annotations.length)}:`,
    ...annotations.map(annotationBlock),
  ].join('\n\n')
}
