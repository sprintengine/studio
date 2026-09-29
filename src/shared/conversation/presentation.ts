import {
  presentToolItem as presentPortableToolItem,
  type PresentableTool,
  type ToolPresentation,
} from '../../../packages/conversation-protocol/src/presentation'

export * from '../../../packages/conversation-protocol/src/presentation'

// Steps with no kind of their own that still say what they did better than
// their tool's name does. Kept on this side of the portable package, whose
// source a companion mirrors byte for byte: moving these there is a change
// made to both at once.
function otherTitle(item: PresentableTool, live: boolean): string | undefined {
  if (item.name === 'GenerateImage') return live ? 'Generating image' : 'Generated image'
  if (item.name === 'Sleep') {
    const input = item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? item.input : {}
    const ms = typeof input.durationMs === 'number' ? input.durationMs : 0
    const span = ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`
    return `${live ? 'Waiting' : 'Waited'} ${span}`
  }
  return undefined
}

export function presentToolItem(
  item: PresentableTool,
  labelCommand?: (command: string) => { title: string } | string,
): ToolPresentation {
  const presentation = presentPortableToolItem(item, labelCommand)
  // Malformed items are the portable presentation's to make readable.
  const title = item && presentation.icon === 'other' ? otherTitle(item, item.status === 'running') : undefined
  return title ? { ...presentation, title } : presentation
}
