import assert from 'node:assert/strict'

import {
  countDocListItems,
  extractBodyHtml,
  extractStages,
  extractStyleBlocks,
  parseComponentDoc,
  representativeStage,
  sentenceCaseLabel,
} from './bundle-parse'
import { composePreviewSrcDoc, stripActiveContent, stripDemoCaptions } from './preview-doc'

// The isolation contract and the extraction that feeds it. Component HTML and
// CSS are third-party content: they must not restyle app chrome, app tokens must
// not bleed into them, and nothing in a preview may execute or fetch.

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// ── Isolation ────────────────────────────────────────────────────────────────

run('a composed preview can execute nothing and fetch nothing', () => {
  const html = composePreviewSrcDoc({
    tokensCss: ':root{--sem-color-bg-app:#fff}',
    componentCss: '.b{color:red}',
    inlineStyles: ['.demo{padding:8px}'],
    bodyHtml:
      '<div onclick="steal()"><script>fetch("http://evil")</script>' +
      '<link rel="stylesheet" href="../../foundations/tokens.css">' +
      '<img src="http://evil/x.png"></div>',
    mode: 'dark',
  })
  assert.ok(!/<script/i.test(html), 'no script survives')
  assert.ok(!/<link/i.test(html), 'no external stylesheet survives')
  assert.ok(!/onclick/i.test(html), 'no inline handler survives')
  assert.ok(!/http:\/\/evil/.test(html), 'no external URL survives')
  // The CSP is the belt to sandbox=""'s braces.
  assert.match(html, /default-src 'none'/)
  assert.match(html, /img-src data:/)
  assert.match(html, /font-src data:/)
})

run('a component that styles body cannot reach app chrome, and our tokens are absent', () => {
  // The acceptance criterion, made concrete: the component's `body { … }` lands
  // in the preview document's own body. Nothing about this string can affect the
  // app, because it is only ever assigned to an iframe's srcDoc.
  const html = composePreviewSrcDoc({
    tokensCss: ':root{--sem-color-bg-app:#111}',
    componentCss: 'body{background:magenta!important} :root{--text-strong:magenta}',
    inlineStyles: [],
    bodyHtml: '<button class="ds-button">Continue</button>',
    mode: 'light',
  })
  assert.match(html, /body\{background:magenta!important\}/, 'the rule is inside the frame document')
  // App-chrome aliases (--text-*, --control-*) are OUR renderer names; a preview
  // only ever carries the bundle's own --sem-*/--ref-* block.
  assert.ok(!/--control-height/.test(html))
  assert.ok(!/var\(--bg-app\)/.test(html), 'and never the themed app canvas')
  // The frame is what enforces it; assert the caller cannot forget the sandbox
  // by checking the document is standalone (a full doctype, not a fragment).
  assert.match(html, /^<!doctype html>/)
})

run('the bundle’s tokens come before the component’s styles', () => {
  const html = composePreviewSrcDoc({
    tokensCss: '/*TOKENS*/',
    componentCss: '/*COMPONENT*/',
    inlineStyles: ['/*INLINE*/'],
    bodyHtml: '<b>x</b>',
    mode: 'light',
  })
  assert.ok(
    html.indexOf('/*TOKENS*/') < html.indexOf('/*INLINE*/'),
    'tokens precede the demo styles',
  )
  assert.ok(
    html.indexOf('/*INLINE*/') < html.indexOf('/*COMPONENT*/'),
    'and the component sheet is last, so it wins ties as it does in its own repo',
  )
})

run('the mode rides the root, and reduced motion is honoured', () => {
  const dark = composePreviewSrcDoc({
    tokensCss: '',
    componentCss: '',
    inlineStyles: [],
    bodyHtml: '<b>x</b>',
    mode: 'dark',
  })
  assert.match(dark, /<html lang="en" data-mode="dark">/)
  assert.match(dark, /prefers-reduced-motion: reduce/)
})

run('the demo’s prose captions are REMOVED from the composed document', () => {
  // The owner's ruling (2026-09-08): the caption is not demoted, it is not on
  // the page. A stylesheet override would leave a paragraph of prose under
  // every specimen — quieter, still read, still pushing the next component off
  // the screen — and would leave the frame's measured height paying for text
  // nobody wanted. Removing the element is the only version that is honest
  // about the height.
  const stage =
    '<p class="demo-label">Light — labels: the tone classifies the row.</p>\n' +
    '<div class="demo-row"><button class="ds-button">Continue</button></div>'
  const html = composePreviewSrcDoc({
    tokensCss: ':root{--sem-color-bg-app:#fff}',
    componentCss: '',
    inlineStyles: [],
    bodyHtml: stage,
    mode: 'light',
  })
  assert.ok(!html.includes('demo-label'), 'the element is gone, not hidden')
  assert.ok(!html.includes('the tone classifies the row'), 'and so is the sentence')
  // Everything else is kept EXACTLY as authored: the rows still read visually
  // and the states are still legible by shape.
  assert.match(html, /demo-row/)
  assert.match(html, /ds-button/)
})

run('a caller that wants the bundle’s markup untouched can still have it', () => {
  const html = composePreviewSrcDoc({
    tokensCss: '',
    componentCss: '',
    inlineStyles: [],
    bodyHtml: '<p class="demo-label">As authored.</p><div class="demo-row">x</div>',
    mode: 'light',
    captions: 'as-authored',
  })
  assert.match(html, /demo-label/)
  assert.match(html, /As authored\./)
})

run('only the caption goes: class lists, attributes and neighbours survive', () => {
  // The bundle format is regular — `demo-label` only ever appears on a `<p>`,
  // one class among others, never nested — which is what makes one expression
  // enough. Each case below is a spelling that appears in a real bundle.
  assert.equal(
    stripDemoCaptions('<p class="demo-label">a</p><p class="demo-note">b</p>'),
    '<p class="demo-note">b</p>',
    'a paragraph that is not a caption stays',
  )
  assert.equal(
    stripDemoCaptions('<p id="x" class="lead demo-label small" data-k="v">a</p>b'),
    'b',
    'extra classes and attributes do not save it',
  )
  assert.equal(
    stripDemoCaptions('<p class="demo-label">a<em>b</em>c</p>keep'),
    'keep',
    'and neither does markup inside it',
  )
  assert.equal(
    stripDemoCaptions('<p class="demo-labelled">a</p>'),
    '<p class="demo-labelled">a</p>',
    'a class that merely starts the same is not the caption',
  )
  assert.equal(
    stripDemoCaptions('<p class="demo-label">one</p>mid<p class="demo-label">two</p>end'),
    'midend',
    'every caption in the stage, not just the first',
  )
})

run('@import is stripped rather than left to fail silently', () => {
  const html = composePreviewSrcDoc({
    tokensCss: '@import url("http://evil/x.css");:root{--a:1}',
    componentCss: '',
    inlineStyles: [],
    bodyHtml: '<b>x</b>',
    mode: 'light',
  })
  assert.ok(!/@import/.test(html))
  assert.match(html, /--a:1/, 'the rest of the block survives')
})

run('stripActiveContent handles unclosed and attribute-bearing script tags', () => {
  assert.equal(stripActiveContent('<script src="x"></script>a'), 'a')
  assert.equal(stripActiveContent('<script>let a = "</b>"</script>b'), 'b')
  assert.equal(stripActiveContent("<div onmouseover='x()'>c</div>"), '<div>c</div>')
})

// ── Extraction ───────────────────────────────────────────────────────────────

const DEMO = `<!doctype html>
<html><head>
<link rel="stylesheet" href="../../foundations/tokens.css" />
<style>.demo-stage{padding:8px}</style>
<style>.demo-row{gap:4px}</style>
</head>
<body>
<div class="demo-stage" data-mode="light">
  <p class="demo-label">Light</p>
  <button class="ds-button">Continue</button>
</div>
<div class="demo-stage" data-mode="dark">
  <button class="ds-button">Continue</button>
</div>
</body></html>`

run('style blocks come out in document order', () => {
  assert.deepEqual(extractStyleBlocks(DEMO), ['.demo-stage{padding:8px}', '.demo-row{gap:4px}'])
})

run('the body is extracted, and a fragment with no body still works', () => {
  const body = extractBodyHtml(DEMO)
  assert.ok(body.includes('demo-stage'))
  assert.ok(!body.includes('<head'), 'head furniture is gone')
  const fragment = extractBodyHtml('<div class="only">x</div>')
  assert.equal(fragment.trim(), '<div class="only">x</div>')
})

run('stages are the top-level children, each with its declared mode', () => {
  const stages = extractStages(extractBodyHtml(DEMO))
  assert.equal(stages.length, 2, 'two stages, not the nested children')
  assert.deepEqual(stages.map((stage) => stage.mode), ['light', 'dark'])
  assert.ok(stages[0].html.includes('demo-label'), 'a stage carries its whole subtree')
  assert.ok(!stages[0].html.includes('data-mode="dark"'), 'and stops at its own close tag')
})

run('nesting, void elements and single quotes do not confuse the scanner', () => {
  const stages = extractStages(
    `<section data-mode='light'><div><span>a</span><br><img src="x.png"></div></section>` +
      `<hr>` +
      `<section data-mode="dark"><div>b</div></section>`,
  )
  assert.deepEqual(stages.map((stage) => stage.mode), ['light', null, 'dark'])
  assert.equal(stages[1].html, '<hr>', 'a void element at the top level is its own stage')
})

run('a body with no elements is still one previewable stage', () => {
  const stages = extractStages('just text')
  assert.deepEqual(stages, [{ mode: null, html: 'just text' }])
  assert.deepEqual(extractStages('   '), [], 'and whitespace is nothing at all')
})

run('a stray close tag does not swallow the rest of the document', () => {
  const stages = extractStages('</div><section data-mode="light">a</section>')
  assert.equal(stages.length, 1)
  assert.equal(stages[0].mode, 'light')
})

run('the representative stage matches the app mode, else falls back to the first', () => {
  const stages = extractStages(extractBodyHtml(DEMO))
  assert.equal(representativeStage(stages, 'dark')?.mode, 'dark')
  assert.equal(representativeStage(stages, 'light')?.mode, 'light')
  // A bundle whose stages declare no mode still previews, on the first one.
  const unlabelled = extractStages('<div>a</div><div>b</div>')
  assert.equal(representativeStage(unlabelled, 'dark')?.html, '<div>a</div>')
  assert.equal(representativeStage([], 'light'), null)
})

// ── component.md ─────────────────────────────────────────────────────────────

const DOC = `# Button

## Anatomy
Label, optional leading glyph.

## Variants
- primary
- secondary
- ghost

## States
- rest
- hover
- focus-visible
- disabled

## Usage
One primary per view.

## Accessibility
Native button; the focus ring is never suppressed.
`

run('the five fixed sections parse, verbatim', () => {
  const doc = parseComponentDoc(DOC)
  assert.ok(doc)
  assert.equal(doc.anatomy, 'Label, optional leading glyph.')
  assert.match(doc.variants, /- primary\n- secondary\n- ghost/)
  assert.equal(doc.usage, 'One primary per view.')
  assert.match(doc.accessibility, /focus ring is never suppressed/)
})

run('counts come from the doc’s list items, and are null when there is no list', () => {
  const doc = parseComponentDoc(DOC)
  assert.equal(countDocListItems(doc?.variants), 3)
  assert.equal(countDocListItems(doc?.states), 4)
  // Prose, not a list: no number rather than a wrong number.
  assert.equal(countDocListItems(doc?.usage), null)
  assert.equal(countDocListItems(undefined), null)
  assert.equal(countDocListItems('1. one\n2. two'), 2, 'ordered lists count too')
})

run('a doc with none of the fixed sections is null, not five empty strings', () => {
  assert.equal(parseComponentDoc('# Button\n\nSome prose.\n'), null)
})

run('sentence case, never uppercase letter-spaced labels', () => {
  assert.equal(sentenceCaseLabel('components'), 'Components')
  assert.equal(sentenceCaseLabel('motion-rules'), 'Motion rules')
})

for (const test of tests) {
  try {
    test.body()
    console.log(`ok - ${test.name}`)
  } catch (error) {
    console.error(`not ok - ${test.name}`)
    throw error
  }
}
console.log('preview-doc.test.ts: ok')
