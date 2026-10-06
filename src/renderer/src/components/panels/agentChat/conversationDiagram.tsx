import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  appearanceKey,
  cachedDiagram,
  drawDiagram,
  subscribeAppearance,
  type DiagramResult,
} from '../../../lib/diagram/mermaidDiagram'

const DIAGRAM_LANGUAGES = new Set(['mermaid', 'mmd'])

export function isDiagramLanguage(language: string | undefined): boolean {
  return DIAGRAM_LANGUAGES.has((language ?? '').toLowerCase())
}

const subscribeNothing = () => () => undefined

/** Mermaid's complaint, cut to the line that says what is wrong. */
function diagramNote(error: string): string {
  const first = error.split('\n', 1)[0].trim().replace(/:$/u, '')
  return first ? `Shown as source: ${first}` : 'Shown as source: the diagram could not be drawn'
}

/**
 * What a reply's ```mermaid block draws in place of its source: nothing while
 * the message streams — a diagram half-typed does not parse, and redrawing
 * it every token would flicker — then the diagram once the block is complete.
 * One that does not parse keeps its source, with a note under it saying why.
 *
 * Drawn for the window's current appearance; after a switch the previous
 * drawing stays up until the new one is ready, so the block never drops back
 * to its source in between.
 */
export function useDiagramDrawing(
  code: string,
  language: string | undefined,
  streaming: boolean | undefined,
): { drawing?: ReactNode; note?: string } {
  const wanted = !streaming && isDiagramLanguage(language)
  // Only a diagram listens for the appearance: every other block in a reply
  // goes through this hook too.
  const appearance = useSyncExternalStore(
    isDiagramLanguage(language) ? subscribeAppearance : subscribeNothing,
    appearanceKey,
    appearanceKey,
  )
  const cached = wanted ? cachedDiagram(appearance, code) : undefined
  const [drawn, setDrawn] = useState<{ code: string; appearance: string; result: DiagramResult } | null>(null)
  useEffect(() => {
    if (!wanted || cached) return
    let current = true
    void drawDiagram(appearance, code).then((result) => {
      if (current) setDrawn({ code, appearance, result })
    })
    return () => {
      current = false
    }
  }, [wanted, cached, appearance, code])
  const result = cached ?? (drawn?.code === code ? drawn.result : undefined)
  if (!wanted || !result) return {}
  if ('error' in result) return { note: diagramNote(result.error) }
  return { drawing: <DiagramSvg svg={result.svg} /> }
}

// The SVG has been sanitized on its way out of the renderer
// (`sanitizeDiagramSvg`), which is what makes setting it as markup safe.
function DiagramSvg({ svg }: { svg: string }) {
  return <div className="contents" dangerouslySetInnerHTML={{ __html: svg }} />
}
