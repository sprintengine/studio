import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildDesignArtifactIndex,
  type DesignArtifactEntry,
  type DesignArtifactKind,
} from './designArtifacts'
import {
  buildComponentGalleryModel,
  componentSectionCountLabel,
  humanizeComponentName,
} from './componentGallery'
import { ComponentGalleryPane } from './ComponentGalleryPane'

// Synthetic 30-component bundle (T15 performance sweep). Real observed bundles
// are small (~3 components); the gallery's guards — the eager-mount limit and
// path+mtime card keying — exist for the 30+ case, so this exercises exactly
// that scale: model derivation cost, per-card key stability under a single-file
// change, and the lazy-mount gate in the rendered markup.

const COMPONENT_COUNT = 30

function entry(relativePath: string, kind: DesignArtifactKind, mtime: number): DesignArtifactEntry {
  const name = relativePath.split('/').pop() as string
  return {
    name,
    relativePath,
    absolutePath: `/ws/${relativePath}`,
    kind,
    typeLabel: 'X',
    modifiedAt: null,
    modifiedAtMs: mtime,
  }
}

const entries: DesignArtifactEntry[] = []
for (let index = 0; index < COMPONENT_COUNT; index += 1) {
  const name = `component-${String(index).padStart(2, '0')}`
  entries.push(entry(`design-system/components/${name}/component.html`, 'page', 1000 + index))
  entries.push(entry(`design-system/components/${name}/component.md`, 'notes', 2000 + index))
}
for (let index = 0; index < 8; index += 1) {
  entries.push(entry(`design-system/glyphs/glyph-${index}.svg`, 'image', 3000 + index))
}
entries.push(entry('design-system/foundations/tokens.css', 'stylesheet', 4000))
entries.push(entry('design-system/foundations/principles.md', 'notes', 4001))

const index = buildDesignArtifactIndex(entries)
const model = buildComponentGalleryModel(index)

assert.equal(model.components.length, COMPONENT_COUNT)
assert.equal(model.builtCount, COMPONENT_COUNT)
assert.equal(model.buildingCount, 0)
assert.equal(componentSectionCountLabel(model), String(COMPONENT_COUNT))
assert.equal(model.glyphs.length, 8)
assert.equal(model.foundations.length, 2)

// Path+mtime keying: bumping ONE component's html mtime changes only that
// card's renderKey — the whole-grid identity stays put, so only the changed
// card remounts its live frame.
const bumped = entries.map((item) =>
  item.relativePath === 'design-system/components/component-07/component.html'
    ? { ...item, modifiedAtMs: 9999 }
    : item,
)
const bumpedModel = buildComponentGalleryModel(buildDesignArtifactIndex(bumped))
const changedCards = bumpedModel.components.filter(
  (component, position) => component.renderKey !== model.components[position].renderKey,
)
assert.equal(changedCards.length, 1, 'a single-file mtime bump changes exactly one renderKey')
assert.equal(changedCards[0].name, 'component-07')

// Model derivation runs on every index publish (watch event / poll edge), so it
// must stay micro-cheap at 30 components. The bound is deliberately loose — the
// assert catches accidental quadratic blowups, the log records the real number.
const modelStart = performance.now()
const MODEL_ITERATIONS = 200
for (let iteration = 0; iteration < MODEL_ITERATIONS; iteration += 1) {
  buildComponentGalleryModel(index)
}
const perBuildMs = (performance.now() - modelStart) / MODEL_ITERATIONS
assert.ok(perBuildMs < 50, `model build should be far under 50ms, got ${perBuildMs.toFixed(3)}ms`)

// Full-grid render at 30 ready components: exactly EAGER_CARD_LIMIT (12) cards
// mount their live frame eagerly ("Loading…" is the eager HtmlPreviewCard's
// pre-read state; effects do not run under renderToStaticMarkup); the remaining
// 18 hold their grid slot as clickable placeholders until scrolled into view.
const renderStart = performance.now()
const markup = renderToStaticMarkup(
  createElement(ComponentGalleryPane, { designArtifacts: index, onOpenFile: () => {} }),
)
const renderMs = performance.now() - renderStart
const eagerCards = markup.split('Loading…').length - 1
assert.equal(eagerCards, 12, 'lazy-mount gate: only the first 12 ready cards mount live frames')
for (const component of model.components) {
  assert.ok(
    markup.includes(humanizeComponentName(component.name)),
    `every component card renders (missing ${component.name})`,
  )
}
assert.ok(markup.includes('30'), 'section header carries the honest 30 count')

console.log(
  `componentGallery 30-component synthetic: model ${perBuildMs.toFixed(3)}ms/build (${MODEL_ITERATIONS} iterations), ` +
    `static render ${renderMs.toFixed(1)}ms, eager frames ${eagerCards}/${COMPONENT_COUNT}`,
)
console.log('componentGallery.test.ts passed')
