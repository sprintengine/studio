import { Fragment, memo } from 'react'
import { splitMarkdownSegments } from '../../../../../shared/conversation/markdownSegments'
import { renderMarkdown } from '../../../utils/markdown'

type MarkdownOptions = Parameters<typeof renderMarkdown>[1]

type SegmentProps = { source: string; options?: MarkdownOptions; frozen: boolean }
const MarkdownSegment = memo(
  function MarkdownSegment({ source, options, frozen }: SegmentProps) {
    return <>{renderMarkdown(source, { ...options, bare: true, streaming: frozen ? false : options?.streaming })}</>
  },
  (previous, next) => {
    if (previous.source !== next.source || previous.frozen !== next.frozen) return false
    const before = previous.options ?? {}
    const after = next.options ?? {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      if (key === 'streaming' && previous.frozen && next.frozen) continue
      if (before[key as keyof MarkdownOptions] !== after[key as keyof MarkdownOptions]) return false
    }
    return true
  },
)

export function StreamingMarkdown({ source, options }: { source: string; options?: MarkdownOptions }) {
  const { frozen, tail } = splitMarkdownSegments(source)
  const segments = tail ? [...frozen, tail] : frozen
  return (
    <div className="markdown-rendered">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 ? ' ' : null}
          <MarkdownSegment source={segment} options={options} frozen={index < frozen.length} />
        </Fragment>
      ))}
    </div>
  )
}
