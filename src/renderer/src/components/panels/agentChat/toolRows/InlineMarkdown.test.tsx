import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { InlineMarkdown, plainInlineText } from './InlineMarkdown'

const html = (text: string) => renderToStaticMarkup(<InlineMarkdown text={text} />)

test('bold, emphasis, strike and code render as marks, not as their punctuation', () => {
  expect(html('Use the **compact** scale')).toContain('<strong class="font-semibold">compact</strong>')
  expect(html('an *aside* and _another_')).toContain('<em>aside</em>')
  expect(html('an *aside* and _another_')).toContain('<em>another</em>')
  expect(html('~~gone~~')).toContain('<s>gone</s>')
  expect(html('run `npm test`')).toMatch(/<code[^>]*>npm test<\/code>/u)
})

test('marks inside a code span stay literal', () => {
  expect(html('`**not bold**`')).toMatch(/<code[^>]*>\*\*not bold\*\*<\/code>/u)
})

test('identifiers and arithmetic with underscores or asterisks are not emphasis', () => {
  expect(html('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4')
})

test('block syntax is dropped and a link becomes its label, so no control nests in a label', () => {
  const markup = html('# Keep\n- the current [docs](https://example.com) look')
  expect(markup).toBe('Keep the current docs look')
  expect(markup).not.toContain('<a')
  expect(markup).not.toContain('<h1')
})

test('the plain form keeps the words and drops the marks', () => {
  expect(plainInlineText('Which **scale** should `chat` use?')).toBe('Which scale should chat use?')
})
