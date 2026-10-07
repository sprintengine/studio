import { expect, test } from 'vitest'

import {
  attachedFileName,
  attachedFilePaths,
  attachedFilesOf,
  attachedFileType,
  middleTruncateFileName,
} from './attachedFiles'

test('a draft’s cards travel as a list of paths beside the words, and come back as the same cards', () => {
  const paths = ['/Users/dev/Desktop/Q3 budget.xlsx', 'C:\\Users\\dev\\Deck one.pptx']
  expect(attachedFilesOf(paths)).toEqual([
    { path: '/Users/dev/Desktop/Q3 budget.xlsx' },
    { path: 'C:\\Users\\dev\\Deck one.pptx' },
  ])
  expect(attachedFilePaths(attachedFilesOf(paths))).toEqual(paths)
  expect(attachedFilePaths(undefined)).toEqual([])
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
