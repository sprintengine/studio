import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { deriveEditHunks } from '../../../../shared/conversation/editHunks'
import { InlineDiff } from './InlineDiff'

test('each replaced line is emphasized against its own new version', () => {
  const [edit] = deriveEditHunks({
    path: 'notes.txt',
    oldText: 'alpha one\nbeta two\n',
    newText: 'alpha uno\nbeta dos\n',
  })
  const marks = [...renderToStaticMarkup(<InlineDiff edit={edit!} />).matchAll(/<mark>([^<]*)<\/mark>/gu)].map(
    (match) => match[1],
  )
  expect(marks).toEqual(['one', 'two', 'uno', 'dos'])
})
