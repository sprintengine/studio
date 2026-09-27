import React, { Component, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { GhostButton } from './Buttons'
import { copyToClipboardWithToast } from '../../utils/copyToClipboardWithToast'
import {
  cachedCodeLines,
  HIGHLIGHT_LINE_LIMIT,
  IncrementalCodeTokenizer,
  loadCodeLanguage,
  normalizeCodeLanguage,
  type CodeLine,
} from '../../lib/highlight/codeHighlight'
import '../../../../../design-system/components/code-block/component.css'

export type CodeBlockProps = {
  code: string
  language?: string
  filename?: string
  streaming?: boolean
  /** Header actions a surface adds for its own kind of block, set before Wrap and Copy. */
  actions?: ReactNode
}

const TokenLine = memo(function TokenLine({ line }: { line: CodeLine }) {
  return (
    <>
      {line.tokens.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.content}
        </span>
      ))}
    </>
  )
})

function HighlightedSource({ code, language, streaming }: CodeBlockProps) {
  const normalized = normalizeCodeLanguage(language)
  const tokenizer = useRef<{ language: string; value: IncrementalCodeTokenizer } | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    if (!normalized) return
    void loadCodeLanguage(normalized)
      .then((engine) => {
        if (cancelled) return
        tokenizer.current = { language: normalized, value: new IncrementalCodeTokenizer(engine, normalized) }
        setReady(normalized)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [normalized])
  if (!normalized || failed) return <code>{code}</code>
  const cached = !streaming ? cachedCodeLines(normalized, code) : undefined
  const current = tokenizer.current
  const lines =
    cached ?? (ready === normalized && current?.language === normalized ? current.value.update(code, !streaming) : null)
  if (!lines)
    return (
      <code aria-busy="true" style={{ visibility: 'hidden' }}>
        {code}
      </code>
    )
  return (
    <code>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          <TokenLine line={line} />
          {index < lines.length - 1 ? '\n' : null}
        </React.Fragment>
      ))}
    </code>
  )
}

class CodeBoundary extends Component<{ children: ReactNode; code: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <code>{this.props.code}</code> : this.props.children
  }
}

export function CodeBlock(props: CodeBlockProps) {
  const [wrap, setWrap] = useState(false)
  return (
    <section
      className={`ds-code-block${wrap ? ' ds-code-block--wrap' : ''}`}
      aria-label={`${props.language || 'Plain text'} code`}
    >
      <div className="ds-code-block__header">
        <span className="ds-code-block__label">{props.filename || props.language || 'Plain text'}</span>
        {props.actions}
        <GhostButton size="xs" aria-label="Wrap code" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
          Wrap
        </GhostButton>
        <GhostButton size="xs" aria-label="Copy code" onClick={() => void copyToClipboardWithToast(props.code)}>
          Copy
        </GhostButton>
      </div>
      <pre>
        <CodeBoundary code={props.code}>
          <HighlightedSource {...props} />
        </CodeBoundary>
      </pre>
      {props.code.split('\n').length > HIGHLIGHT_LINE_LIMIT ? (
        <div className="ds-code-block__note">Highlighting stopped at 2000 lines</div>
      ) : null}
    </section>
  )
}
