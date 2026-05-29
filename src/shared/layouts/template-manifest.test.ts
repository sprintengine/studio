import assert from 'node:assert/strict'

import { parseLayoutTemplateManifest, validateLayoutTemplateManifest } from './template-manifest'

const VALID_LAYOUT = { global: {}, borders: [], layout: { type: 'row', children: [] } }

function testValidMinimal(): void {
  const result = validateLayoutTemplateManifest({ id: 'solo-dev', name: 'Solo dev', layout: VALID_LAYOUT })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.manifest.id, 'solo-dev')
    assert.equal(result.manifest.description, undefined)
    assert.equal(result.manifest.previewSlots, undefined)
  }
}

function testValidFull(): void {
  const result = validateLayoutTemplateManifest({
    id: 'duo',
    name: 'Duo',
    description: 'Two agents side by side.',
    previewSlots: [{ x: 0, y: 0, w: 1, h: 1, type: 'agent', label: 'A' }],
    layout: VALID_LAYOUT,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.manifest.previewSlots?.length, 1)
}

function testRejectsNonObject(): void {
  assert.equal(validateLayoutTemplateManifest(null).ok, false)
  assert.equal(validateLayoutTemplateManifest([]).ok, false)
}

function testRejectsBadId(): void {
  const result = validateLayoutTemplateManifest({ id: 'Bad Id', name: 'X', layout: VALID_LAYOUT })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'id'))
}

function testRejectsEmptyName(): void {
  const result = validateLayoutTemplateManifest({ id: 'x', name: '  ', layout: VALID_LAYOUT })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'name'))
}

function testRejectsMissingLayout(): void {
  const result = validateLayoutTemplateManifest({ id: 'x', name: 'X' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'layout'))
}

function testRejectsBadLayoutRoot(): void {
  const notRow = validateLayoutTemplateManifest({ id: 'x', name: 'X', layout: { layout: { type: 'tabset' } } })
  assert.equal(notRow.ok, false)
  if (!notRow.ok) assert.ok(notRow.issues.some((issue) => issue.path === 'layout.layout'))

  const noChildren = validateLayoutTemplateManifest({ id: 'x', name: 'X', layout: { layout: { type: 'row' } } })
  assert.equal(noChildren.ok, false)
  if (!noChildren.ok) assert.ok(noChildren.issues.some((issue) => issue.path === 'layout.layout.children'))
}

function testRejectsBadPreviewSlot(): void {
  const result = validateLayoutTemplateManifest({
    id: 'x',
    name: 'X',
    layout: VALID_LAYOUT,
    previewSlots: [{ x: 0, y: 0, w: 1, h: 1, type: 'nope', label: 'A' }],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'previewSlots[0].type'))
}

function testParseInvalidJson(): void {
  const result = parseLayoutTemplateManifest('{ not json')
  assert.equal(result.ok, false)
}

testValidMinimal()
testValidFull()
testRejectsNonObject()
testRejectsBadId()
testRejectsEmptyName()
testRejectsMissingLayout()
testRejectsBadLayoutRoot()
testRejectsBadPreviewSlot()
testParseInvalidJson()
console.log('layout-template-manifest tests passed')
