import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { loadTypesetter } from '../lib/math/typesetMath'
import { renderMarkdown } from './markdown'

type Options = NonNullable<Parameters<typeof renderMarkdown>[1]>

function renderReply(markdown: string, options: Options = {}): string {
  return renderToStaticMarkup(<>{renderMarkdown(markdown, { density: 'chat', math: true, ...options })}</>)
}

// A stand-in for the chat's code block that says what it was handed.
function CodeStub({ code, language, note }: { code: string; language?: string; note?: string }) {
  return (
    <pre data-stub={language ?? ''} data-note={note ?? ''}>
      {code}
    </pre>
  )
}

// Runs first: the typesetter is loaded on the first formula, not with the app.
test('before the typesetter has loaded, a formula shows as its source', () => {
  const html = renderReply('Area is $$\\pi r^2$$.')
  expect(html).toMatch(/<code[^>]*>\\pi r\^2<\/code>/u)
  expect(html).not.toContain('class="katex"')
})

test('inline math between doubled dollars is typeset', async () => {
  await loadTypesetter()
  const html = renderReply('Area is $$\\pi r^2$$.')
  expect(html).toContain('data-math="inline"')
  expect(html).toContain('data-tex="\\pi r^2"')
  expect(html).toContain('class="katex"')
})

test('prices and shell variables stay text', async () => {
  await loadTypesetter()
  for (const prose of [
    'The plan costs $5 and the team plan $10.',
    'It reads $HOME and then $PATH.',
    'Between $5-$10, or $20 if expedited.',
    'Run `echo $$` to print the pid.',
    'I was charged $$100 and then $$200.',
  ]) {
    const html = renderReply(prose)
    expect(html, prose).not.toContain('data-math')
    expect(html, prose).not.toContain('katex')
  }
  expect(renderReply('It reads $HOME and then $PATH.')).toContain('It reads $HOME and then $PATH.')
  expect(renderReply('I was charged $$100 and then $$200.')).toContain('I was charged $$100 and then $$200.')
})

test('math inside a code span or a code block is left as written', async () => {
  await loadTypesetter()
  const span = renderReply('Write `$$x^2$$` or `\\(x\\)` in the doc.')
  expect(span).not.toContain('data-math')
  expect(span).toContain('$$x^2$$')
  expect(span).toContain('\\(x\\)')

  const fence = ['```bash', 'echo "$$" \\(not math\\)', 'echo $$a$$', '```'].join('\n')
  const block = renderReply(fence, { codeBlock: CodeStub })
  expect(block).not.toContain('data-math')
  expect(block).toContain('data-stub="bash"')
  expect(block).toContain('echo &quot;$$&quot; \\(not math\\)\necho $$a$$')

  const indented = renderReply(['Before.', '', '    \\[ x \\]', '    $$y$$'].join('\n'))
  expect(indented).not.toContain('data-math')
})

test('a $$ block and a ```math fence are drawn as display math once the message settles', async () => {
  await loadTypesetter()
  for (const source of ['$$\n\\frac{a}{b}\n$$', '```math\n\\frac{a}{b}\n```']) {
    const html = renderReply(source, { codeBlock: CodeStub })
    expect(html, source).toContain('data-math="display"')
    expect(html, source).toContain('katex-display')
    expect(html, source).not.toContain('data-stub')
  }
})

test('a display formula stays its source while the message streams', async () => {
  await loadTypesetter()
  const html = renderReply('$$\n\\frac{a}{b}\n$$', { codeBlock: CodeStub, streaming: true })
  expect(html).not.toContain('data-math')
  expect(html).toContain('data-stub="math"')
  expect(html).toContain('\\frac{a}{b}')
})

test('backslash delimiters: \\( inline, and \\[ on lines of its own as a block', async () => {
  await loadTypesetter()
  expect(renderReply('So \\(x^2 + y^2\\) holds.')).toContain('data-math="inline"')

  const alone = renderReply('\\[\nE = mc^2\n\\]')
  expect(alone).toContain('data-math="display"')

  // Straight under a sentence, as agents write it: the paragraph splits round the block.
  const under = renderReply('The energy is:\n\\[\nE = mc^2\n\\]\nwhere c is the speed of light.')
  expect(under).toMatch(/<p[^>]*>The energy is:<\/p>\n<div data-math="display" data-tex="E = mc\^2"/u)
  expect(under).toMatch(/<\/div>\n<p[^>]*>where c is the speed of light\.<\/p>/u)

  // Mid-sentence it is the escaped bracket pair markdown always made it.
  const escaped = renderReply('Tag it \\[WIP\\] for now.')
  expect(escaped).not.toContain('data-math')
  expect(escaped).toContain('Tag it [WIP] for now.')
})

test('a formula that does not parse falls back to its source, saying why', async () => {
  await loadTypesetter()
  const broken = renderReply('$$\n\\frac{a}{\n$$', { codeBlock: CodeStub })
  expect(broken).toContain('data-stub="math"')
  expect(broken).toMatch(/data-note="Shown as source: [^"]+"/u)

  const inline = renderReply('Bad $$\\frac{a}{$$ here.')
  expect(inline).not.toContain('data-math')
  expect(inline).toMatch(/<code[^>]*title="Shown as source: [^"]+"[^>]*>\\frac\{a\}\{<\/code>/u)
})

test('a formula cannot reach outside itself', async () => {
  await loadTypesetter()
  // `\href` and `\htmlClass` are refused: drawn as the command's name in the
  // error ink, never as a link or a class on the page.
  const html = renderReply('$$\\href{javascript:alert(1)}{x}$$ and $$\\htmlClass{evil}{y}$$')
  expect(html).not.toMatch(/<a\b|href=/u)
  expect(html).not.toMatch(/class="[^"]*evil/u)
})

test('without math, a document reads dollars as text', async () => {
  await loadTypesetter()
  const html = renderToStaticMarkup(<>{renderMarkdown('Area is $$\\pi r^2$$.', { density: 'chat' })}</>)
  expect(html).not.toContain('data-math')
  expect(html).toContain('$$\\pi r^2$$')
})

test('a ```latex, ```tex or ```katex fence stays code, to read and copy, even when it is a formula', async () => {
  await loadTypesetter()
  for (const language of ['latex', 'tex', 'katex', 'LaTeX']) {
    const html = renderReply(`\`\`\`${language}\n\\frac{a}{b}\n\`\`\``, { codeBlock: CodeStub })
    expect(html, language).not.toContain('data-math')
    expect(html, language).toContain(`data-stub="${language}"`)
    expect(html, language).toContain('\\frac{a}{b}')
  }
  const document = renderReply('```latex\n\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n```', {
    codeBlock: CodeStub,
  })
  expect(document).toContain('data-stub="latex"')
  expect(document).toContain('data-note=""')
})
