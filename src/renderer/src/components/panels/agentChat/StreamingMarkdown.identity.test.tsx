import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { test } from 'vitest'

function Code({ code }: { code: string }) {
  return (
    <section>
      <pre>
        <code>
          <span data-prefix="true">{code.slice(0, 6)}</span>
          {code.slice(6)}
        </code>
      </pre>
    </section>
  )
}

test('the real markdown renderer preserves code and a text selection through append, fence close, and settle', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = dom.window
  globals.document = dom.window.document
  globals.navigator = dom.window.navigator
  globals.HTMLElement = dom.window.HTMLElement
  globals.Node = dom.window.Node
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { StreamingMarkdown } = await import('./StreamingMarkdown')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const prefix = 'Here is the code.\n\n```ts\nexport const value0 = 0\n'
  const append = 'export const value1 = 1\n'
  try {
    act(() => root.render(<StreamingMarkdown source={prefix} options={{ codeBlock: Code, streaming: true }} />))
    const code = container.querySelector('code')
    const firstSpan = container.querySelector('[data-prefix]')
    assert.ok(code)
    assert.ok(firstSpan?.firstChild)
    const selection = dom.window.getSelection()
    const range = dom.window.document.createRange()
    range.selectNodeContents(firstSpan)
    selection?.removeAllRanges()
    selection?.addRange(range)
    assert.equal(selection?.toString(), 'export')

    act(() =>
      root.render(<StreamingMarkdown source={prefix + append} options={{ codeBlock: Code, streaming: true }} />),
    )
    assert.equal(container.querySelector('code'), code)
    assert.equal(container.querySelector('[data-prefix]'), firstSpan)
    assert.equal(selection?.toString(), 'export')

    const closed = `${prefix}${append}\n\u0060\u0060\u0060\n\nAll done.`
    act(() => root.render(<StreamingMarkdown source={closed} options={{ codeBlock: Code, streaming: true }} />))
    assert.equal(container.querySelector('code'), code)
    assert.equal(container.querySelector('[data-prefix]'), firstSpan)
    assert.equal(selection?.toString(), 'export')

    act(() => root.render(<StreamingMarkdown source={closed} options={{ codeBlock: Code, streaming: false }} />))
    assert.equal(container.querySelector('code'), code)
    assert.equal(container.querySelector('[data-prefix]'), firstSpan)
    assert.equal(selection?.toString(), 'export')
  } finally {
    act(() => root.unmount())
    dom.window.close()
  }
})
