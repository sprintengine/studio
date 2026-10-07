import { expect, test } from 'vitest'

import {
  attachedFileName,
  attachedFileType,
  composeMessageWithFiles,
  middleTruncateFileName,
  splitAttachedFiles,
} from './attachedFiles'

test('the agent receives the words, then the attached paths in a paragraph of their own, quoted as a drop is', () => {
  expect(
    composeMessageWithFiles('Summarise these', ['/Users/dev/Desktop/Q3 budget.xlsx', '/Users/dev/notes.pdf']),
  ).toBe("Summarise these\n\n'/Users/dev/Desktop/Q3 budget.xlsx' /Users/dev/notes.pdf")
  expect(composeMessageWithFiles('', ['/Users/dev/notes.pdf']), 'a message of files alone is their paths').toBe(
    '/Users/dev/notes.pdf',
  )
  expect(composeMessageWithFiles('Just words', []), 'no files, no change').toBe('Just words')
})

test('a sent message splits back into its words and its files, however the paths were quoted', () => {
  const paths = [
    '/Users/dev/Desktop/Q3 budget.xlsx',
    "/Users/dev/John's Files/plan.docx",
    '/Users/dev/notes.pdf',
    'C:\\Users\\dev\\Documents\\Deck one.pptx',
    'C:\\Users\\dev\\data.csv',
    '\\\\build-box\\share\\report.pdf',
  ]
  const message = composeMessageWithFiles('Compare these.\n\nThen summarise.', paths)
  expect(splitAttachedFiles(message)).toEqual({ text: 'Compare these.\n\nThen summarise.', paths })
  expect(splitAttachedFiles(composeMessageWithFiles('', paths))).toEqual({ text: '', paths })
})

test('words that only look like paths stay words', () => {
  for (const message of [
    'Look at /Users/dev/notes.pdf please',
    '/review',
    '/model opus',
    'Read this:\n\n/Users/dev/notes.pdf and then that',
    'Two lines\n\n/Users/dev/a.pdf\n/Users/dev/b.pdf',
    // Not spelled as the composer spells it: a hand-typed quote around a path with no space.
    "Here\n\n'/Users/dev/notes.pdf'",
  ])
    expect(splitAttachedFiles(message), message).toEqual({ text: message, paths: [] })
})

test('a file’s card names its type by extension, and by media type when the name has none', () => {
  expect(attachedFileType('Quarterly report.pdf')).toEqual({ kind: 'pdf', label: 'PDF' })
  expect(attachedFileType('/Users/dev/brief.docx')).toEqual({ kind: 'document', label: 'DOCX' })
  expect(attachedFileType('budget.xlsx')).toEqual({ kind: 'spreadsheet', label: 'XLSX' })
  expect(attachedFileType('deck.pptx')).toEqual({ kind: 'presentation', label: 'PPTX' })
  expect(attachedFileType('export.csv')).toEqual({ kind: 'spreadsheet', label: 'CSV' })
  expect(attachedFileType('notes.txt')).toEqual({ kind: 'text', label: 'TXT' })
  expect(attachedFileType('README.md')).toEqual({ kind: 'markdown', label: 'MD' })
  expect(attachedFileType('engine.ts')).toEqual({ kind: 'typescript', label: 'TS' })
  expect(attachedFileType('bundle.zip')).toEqual({ kind: 'archive', label: 'ZIP' })
  expect(attachedFileType('scan', 'application/pdf')).toEqual({ kind: 'pdf', label: 'PDF' })
  expect(attachedFileType('download', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toEqual({
    kind: 'spreadsheet',
    label: 'XLSX',
  })
  expect(attachedFileType('blob')).toEqual({ kind: 'generic', label: 'File' })
  expect(attachedFileType('archive.verylongext')).toEqual({ kind: 'generic', label: 'File' })
})

test('a long name is cut in the middle, keeping its start and its extension', () => {
  expect(middleTruncateFileName('short.pdf', 24)).toBe('short.pdf')
  const cut = middleTruncateFileName('Quarterly financial report final v3.pdf', 24)
  expect(cut).toHaveLength(24)
  expect(cut.startsWith('Quarterly fi')).toBe(true)
  expect(cut.endsWith('v3.pdf')).toBe(true)
  expect(cut).toContain('…')
  expect(middleTruncateFileName('a-name-with-no-extension-at-all', 12)).toHaveLength(12)
})

test('a path’s name is its last segment, whichever separator it uses', () => {
  expect(attachedFileName('/Users/dev/Desktop/Q3 budget.xlsx')).toBe('Q3 budget.xlsx')
  expect(attachedFileName('C:\\Users\\dev\\deck.pptx')).toBe('deck.pptx')
  expect(attachedFileName('/Users/dev/Reports/')).toBe('Reports')
})
