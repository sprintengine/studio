// Sink serialization for annotate batches (MC-1468 part 3). Pure text
// composition over MockupAnnotation[]: the two hosts of HtmlArtifactFrame call
// these to format a submitted batch for their own feedback channel — sprint
// request-changes (SprintEngineBoardPanel) and the wizard designer chat
// (GuidedBriefFlow). The frame itself never imports this module: where a batch
// goes, and in what shape, is host-side only (MC-1468 decision 2), and the
// seam source contract in guidedBriefFlow.test.ts holds this file to the same
// no-plumbing rule as the rest of annotate/.

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

/**
 * Sink B — design wizard. The batch as ONE chat message to the designer
 * session (batch-first: one coherent revision pass, not N interleaved ones).
 * The conversation transport carries full per-pin blocks; terminal (PTY)
 * stdin submits on every newline — the same constraint lintFixRequestMessage
 * works under — so that transport gets the pins composed onto a single line
 * (selector + instruction; the snippet is dropped, the file is in the
 * designer's own workspace).
 */
export function designerAnnotationMessage(
  relativePath: string,
  annotations: readonly MockupAnnotation[],
  transport: 'conversation' | 'terminal',
): string {
  const intro = `Please revise ${relativePath} — ${annotationCount(annotations.length)} from the mockup preview`
  if (transport === 'terminal') {
    const pins = annotations.map(
      (annotation, index) => `[${index + 1}] ${annotation.selector}: ${inline(annotation.message)}`,
    )
    return `${intro}: ${pins.join('; ')}`
  }
  return [`${intro}:`, ...annotations.map(annotationBlock)].join('\n\n')
}
