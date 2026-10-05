import assert from 'node:assert/strict'
import { test } from 'vitest'

import { cliPickerModels } from './cli-model-families'

test('ids that differ only by a window suffix are one family, base window first', () => {
  const models = cliPickerModels([
    { id: 'opus[1m]', label: 'Opus (1M)', origin: 'discovered' },
    { id: 'opus', label: 'Opus', origin: 'discovered' },
  ])
  assert.deepEqual(
    models.map((model) => [model.id, model.family, model.familyDefault, model.contextLabel]),
    [
      ['opus', 'opus', true, 'Standard'],
      ['opus[1m]', 'opus', false, '1M'],
    ],
  )
})

test('a family the catalog ships only suffixed keeps its own id as the row it selects', () => {
  const models = cliPickerModels([{ id: 'sonnet[1m]', label: 'Sonnet (1M)', origin: 'manifest' }])
  assert.deepEqual(models, [
    {
      id: 'sonnet[1m]',
      label: 'Sonnet (1M)',
      family: 'sonnet',
      familyDefault: true,
      contextLabel: '1M',
      origin: 'manifest',
    },
  ])
})

test('one new id marks every id of its family new, as the picker marks the row', () => {
  const models = cliPickerModels([
    { id: 'opus', origin: 'discovered' },
    { id: 'opus[1m]', origin: 'discovered', isNew: true },
    { id: 'haiku', origin: 'discovered' },
  ])
  assert.deepEqual(
    models.map((model) => [model.id, model.isNew]),
    [
      ['opus', true],
      ['opus[1m]', true],
      ['haiku', undefined],
    ],
  )
})

test('families keep the order the catalog was built in', () => {
  const models = cliPickerModels([
    { id: 'gpt-5.5', origin: 'discovered' },
    { id: 'o9', origin: 'discovered' },
    { id: 'gpt-5.5[400k]', origin: 'user' },
  ])
  assert.deepEqual(
    models.map((model) => model.id),
    ['gpt-5.5', 'gpt-5.5[400k]', 'o9'],
  )
})

test('an unlabelled id carries no label, and a blank one is dropped', () => {
  const models = cliPickerModels([
    { id: 'm1', origin: 'user' },
    { id: 'm2', label: '  ', origin: 'user' },
  ])
  assert.equal('label' in models[0]!, false)
  assert.equal('label' in models[1]!, false)
})
