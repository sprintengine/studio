// A board, in text an agent can read.
//
// The audience is a context window, so every choice here is about density and
// determinism: one line per element, a fixed line shape, a stable sort, labels
// clipped, and a hard character ceiling with a line that says what was left out.
// An agent that cannot tell a truncated board from a small one will confidently
// edit the half it was shown.

import type { CanvasElement } from './types'
import { canvasElementBox, canvasElementLabel, indexScene } from './skeleton'
import type { CanvasSceneIndex } from './skeleton'
import { isRecord } from '../records'

/** Roughly six thousand tokens: a large board still leaves room to think. */
export const CANVAS_DESCRIBE_MAX_CHARS = 24000

/** Long enough to identify a shape, short enough that a paragraph in a box does not eat the outline. */
export const CANVAS_DESCRIBE_LABEL_MAX = 80

export type CanvasDescribeDetail = 'summary' | 'outline' | 'full'

export function describeScene(elements: CanvasElement[], detail: CanvasDescribeDetail = 'outline'): string {
  const index = indexScene(elements)
  const visible = index.live.filter((element) => !index.foldedTextIds.has(element.id))
  const header = summaryLines(visible, index)
  if (detail === 'summary') return header.join('\n')

  const listed = visible.slice().sort(compareForReading)
  const lines: string[] = [...header]
  let used = lines.join('\n').length
  let omittedElements = 0
  let omittedLines = 0
  // Room for the truncation line itself, so the ceiling is never exceeded to
  // report that the ceiling was reached.
  const ceiling = CANVAS_DESCRIBE_MAX_CHARS - 200

  const push = (line: string): boolean => {
    if (used + line.length + 1 > ceiling) return false
    lines.push(line)
    used += line.length + 1
    return true
  }

  if (listed.length > 0) {
    push('')
    push('Elements')
    for (let i = 0; i < listed.length; i += 1) {
      if (!push(elementLine(listed[i], index, detail))) {
        omittedElements = listed.length - i
        break
      }
    }
  }

  const rest: string[] = []
  const connections = connectionLines(index)
  if (connections.length > 0) rest.push('', 'Connections', ...connections)
  const groups = groupLines(visible)
  if (groups.length > 0) rest.push('', 'Groups', ...groups)
  const frames = frameLines(visible, index)
  if (frames.length > 0) rest.push('', 'Frames', ...frames)

  for (let i = 0; i < rest.length; i += 1) {
    if (!push(rest[i])) {
      omittedLines = rest.length - i
      break
    }
  }

  if (omittedElements > 0 || omittedLines > 0) {
    lines.push(
      `... truncated at ${CANVAS_DESCRIBE_MAX_CHARS} characters: ${omittedElements} more element(s) and ${omittedLines} more line(s) omitted. Narrow the read with canvas.find.`,
    )
  }
  return lines.join('\n')
}

function summaryLines(visible: CanvasElement[], index: CanvasSceneIndex): string[] {
  const counts = new Map<string, number>()
  for (const element of visible) counts.set(element.type, (counts.get(element.type) ?? 0) + 1)
  const breakdown = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([type, count]) => `${count} ${type}`)
    .join(', ')

  const lines = [`Board: ${visible.length} element(s)${breakdown ? ` (${breakdown})` : ''}.`]
  const bounds = sceneBounds(visible)
  lines.push(
    bounds
      ? `Bounds: (${bounds.x},${bounds.y}) ${bounds.width}x${bounds.height}.`
      : 'Bounds: empty board.',
  )
  const labelled = visible.filter((element) => canvasElementLabel(element, index)).length
  lines.push(`Labelled: ${labelled} of ${visible.length}.`)
  return lines
}

function sceneBounds(
  elements: CanvasElement[],
): { x: number; y: number; width: number; height: number } | null {
  if (elements.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const element of elements) {
    const box = canvasElementBox(element)
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  if (!Number.isFinite(minX)) return null
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  }
}

// Reading order, not scene order: top to bottom, then left to right, then by id
// so two shapes at the same point never swap places between two reads.
function compareForReading(a: CanvasElement, b: CanvasElement): number {
  const left = canvasElementBox(a)
  const right = canvasElementBox(b)
  if (left.y !== right.y) return left.y - right.y
  if (left.x !== right.x) return left.x - right.x
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function elementLine(element: CanvasElement, index: CanvasSceneIndex, detail: CanvasDescribeDetail): string {
  const box = canvasElementBox(element)
  const parts = [
    `[${element.id}] ${element.type} at (${Math.round(box.x)},${Math.round(box.y)}) ${Math.round(box.width)}x${Math.round(box.height)}`,
  ]
  const label = canvasElementLabel(element, index)
  if (label) parts.push(`"${clip(label)}"`)
  const target = bindingTargetLabel(element, index, 'endBinding')
  if (target) parts.push(`-> ${target}`)
  if (detail === 'full') {
    const style = styleNote(element)
    if (style) parts.push(style)
  }
  return parts.join(' ')
}

function styleNote(element: CanvasElement): string {
  const bits: string[] = []
  if (typeof element.strokeColor === 'string') bits.push(`stroke ${element.strokeColor}`)
  if (typeof element.backgroundColor === 'string' && element.backgroundColor !== 'transparent') {
    bits.push(`fill ${element.backgroundColor}`)
  }
  if (typeof element.opacity === 'number' && element.opacity !== 100) bits.push(`opacity ${element.opacity}`)
  if (element.locked === true) bits.push('locked')
  const groupIds = element.groupIds
  if (Array.isArray(groupIds) && typeof groupIds[0] === 'string') bits.push(`group ${groupIds[0]}`)
  if (typeof element.frameId === 'string' && element.frameId) bits.push(`frame ${element.frameId}`)
  return bits.length > 0 ? `[${bits.join(', ')}]` : ''
}

function bindingTargetLabel(
  element: CanvasElement,
  index: CanvasSceneIndex,
  which: 'startBinding' | 'endBinding',
): string | null {
  const binding = element[which]
  if (!isRecord(binding) || typeof binding.elementId !== 'string') return null
  const target = index.byId.get(binding.elementId)
  if (!target || target.isDeleted === true) return null
  const label = canvasElementLabel(target, index)
  return label ? `"${clip(label)}"` : binding.elementId
}

function connectionLines(index: CanvasSceneIndex): string[] {
  const lines: string[] = []
  for (const element of index.live) {
    if (element.type !== 'arrow') continue
    const from = bindingTargetLabel(element, index, 'startBinding')
    const to = bindingTargetLabel(element, index, 'endBinding')
    const label = canvasElementLabel(element, index)
    const note = label ? ` "${clip(label)}"` : ''
    // A dangling end is the single most common reason a board looks right and
    // falls apart on the first drag, so it is called out rather than inferred.
    const flag = from && to ? '' : ' (unattached)'
    lines.push(`${from ?? '?'} --> ${to ?? '?'} (${element.id})${note}${flag}`)
  }
  return lines
}

function groupLines(visible: CanvasElement[]): string[] {
  const groups = new Map<string, string[]>()
  for (const element of visible) {
    const groupIds = element.groupIds
    if (!Array.isArray(groupIds)) continue
    for (const groupId of groupIds) {
      if (typeof groupId !== 'string') continue
      const members = groups.get(groupId)
      if (members) members.push(element.id)
      else groups.set(groupId, [element.id])
    }
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([groupId, members]) => `${groupId}: ${members.join(', ')}`)
}

function frameLines(visible: CanvasElement[], index: CanvasSceneIndex): string[] {
  const lines: string[] = []
  for (const element of visible) {
    if (element.type !== 'frame') continue
    const children = visible.filter((candidate) => candidate.frameId === element.id).map((child) => child.id)
    const label = canvasElementLabel(element, index)
    lines.push(`[${element.id}] "${clip(label || element.id)}" holds ${children.length}: ${children.join(', ')}`)
  }
  return lines
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > CANVAS_DESCRIBE_LABEL_MAX
    ? `${flat.slice(0, CANVAS_DESCRIBE_LABEL_MAX - 1)}...`
    : flat
}
