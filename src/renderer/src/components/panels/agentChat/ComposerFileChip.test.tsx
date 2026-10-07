// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { AttachedFilePreview } from '../../../../../shared/attached-files'
import { useToastStore } from '../../../store/toastStore'
import { ComposerAttachmentStrip } from '../ComposerAttachmentStrip'
import { resetAttachedFilePreviewsForTests } from './ComposerFileChip'

// Main, as the cards reach it: what each path is, and the open and reveal.
let answers: Record<string, AttachedFilePreview>
let release: () => void
let openFails: string | null
const openAttachedFile = vi.fn(async (path: string) => {
  if (openFails) throw new Error(`Error invoking remote method 'attached-files:open': Error: ${openFails}`)
  return path && undefined
})
const showItemInFolder = vi.fn(async () => undefined)

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetAttachedFilePreviewsForTests()
  openFails = null
  openAttachedFile.mockClear()
  showItemInFolder.mockClear()
  answers = {}
  // Previews wait until the test lets them through, so the glyph can be seen first.
  let gate: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    gate = resolve
  })
  release = gate
  ;(window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    previewAttachedFile: async (path: string) => {
      await opened
      return answers[path] ?? { kind: 'missing', thumbnailDataUrl: null, openable: false }
    },
    openAttachedFile,
    showItemInFolder,
  }
  useToastStore.setState({ toasts: [] })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(files: string[], onRemoveFile = vi.fn()) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <ComposerAttachmentStrip
        attachments={[]}
        reading={0}
        onRemove={() => undefined}
        files={files}
        onRemoveFile={onRemoveFile}
      />,
    ),
  )
  return onRemoveFile
}

const card = (label: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

test('a staged file is a card: its type glyph at once, the system’s thumbnail when it arrives', async () => {
  answers['/Users/dev/Desktop/Quarterly report.pdf'] = {
    kind: 'file',
    thumbnailDataUrl: 'data:image/png;base64,AAAA',
    openable: true,
  }
  answers['/Users/dev/Desktop/budget.xlsx'] = { kind: 'file', thumbnailDataUrl: null, openable: true }
  await mount(['/Users/dev/Desktop/Quarterly report.pdf', '/Users/dev/Desktop/budget.xlsx'])
  const pdf = card('Open Quarterly report.pdf')
  expect(pdf?.textContent).toContain('Quarterly report.pdf')
  expect(pdf?.textContent).toContain('PDF')
  expect(card('Open budget.xlsx')?.textContent).toContain('XLSX')
  expect(pdf?.querySelector('svg'), 'the glyph stands in until the thumbnail is drawn').not.toBeNull()
  expect(pdf?.querySelector('img')).toBeNull()
  await act(async () => release())
  expect(pdf?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  expect(card('Open budget.xlsx')?.querySelector('img'), 'no thumbnail keeps the glyph').toBeNull()
})

test('a click opens the file in its app, and a refusal is said in a toast', async () => {
  await mount(['/Users/dev/Desktop/brief.docx'])
  await act(async () => card('Open brief.docx')!.click())
  expect(openAttachedFile).toHaveBeenCalledWith('/Users/dev/Desktop/brief.docx')
  openFails = 'No application knows how to open this file.'
  await act(async () => card('Open brief.docx')!.click())
  expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
    tone: 'error',
    title: 'Could not open brief.docx',
    description: 'No application knows how to open this file.',
  })
})

test('a file not of a kind a click opens is only revealed, by its card and by its menu', async () => {
  await mount(['/Users/dev/Desktop/deploy.sh'])
  const script = card('Reveal in Finder: deploy.sh')
  expect(script, 'the card says what its click does').not.toBeNull()
  await act(async () => script!.click())
  expect(showItemInFolder).toHaveBeenCalledWith('/Users/dev/Desktop/deploy.sh')
  expect(openAttachedFile).not.toHaveBeenCalled()
  await act(async () => {
    script!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }))
  })
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)
  expect(items).toEqual(['Reveal in Finder', 'Remove'])
})

test('the menu opens or reveals a document, and × takes the card away', async () => {
  const onRemoveFile = await mount(['/Users/dev/Desktop/deck.pptx'])
  await act(async () => {
    card('Open deck.pptx')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    )
  })
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
  expect(items().map((item) => item.textContent)).toEqual(['Open', 'Reveal in Finder', 'Remove'])
  await act(async () => items()[1].click())
  expect(showItemInFolder).toHaveBeenCalledWith('/Users/dev/Desktop/deck.pptx')
  expect(items(), 'the menu closes on a pick').toHaveLength(0)
  await act(async () => card('Remove deck.pptx')!.click())
  expect(onRemoveFile).toHaveBeenCalledWith('/Users/dev/Desktop/deck.pptx')
})

test('a folder is a card that shows the folder rather than opening it', async () => {
  answers['/Users/dev/Reports'] = { kind: 'folder', thumbnailDataUrl: null, openable: false }
  await mount(['/Users/dev/Reports'])
  await act(async () => release())
  const folder = card('Reveal in Finder: Reports')
  expect(folder?.textContent).toContain('Folder')
  await act(async () => folder!.click())
  expect(showItemInFolder).toHaveBeenCalledWith('/Users/dev/Reports')
})

test('a kept answer is drawn at once on a re-mount, and main is asked again once it is a few seconds old', async () => {
  const path = '/Users/dev/Desktop/plan.pdf'
  answers[path] = { kind: 'file', thumbnailDataUrl: 'data:image/png;base64,FIRST', openable: true }
  await mount([path])
  await act(async () => release())
  expect(card('Open plan.pdf')?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,FIRST')
  await act(async () => root?.unmount())
  host?.remove()
  // The file was edited: main, which keys by size and modification time, draws it again.
  answers[path] = { kind: 'file', thumbnailDataUrl: 'data:image/png;base64,SECOND', openable: true }
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10_000)
  try {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    // Rendered and read before main's new answer can land.
    act(() =>
      root!.render(<ComposerAttachmentStrip attachments={[]} reading={0} onRemove={() => undefined} files={[path]} />),
    )
    const shown = card('Open plan.pdf')?.querySelector('img')?.getAttribute('src')
    expect(shown, 'the kept picture, with no glyph flash').toBe('data:image/png;base64,FIRST')
    await act(async () => undefined)
    expect(card('Open plan.pdf')?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,SECOND')
  } finally {
    clock.mockRestore()
  }
})

test('a path this computer did not attach is a card that only reveals', async () => {
  answers['/Users/dev/Desktop/brief.pdf'] = { kind: 'unknown', thumbnailDataUrl: null, openable: false }
  await mount(['/Users/dev/Desktop/brief.pdf'])
  await act(async () => release())
  expect(card('Reveal in Finder: brief.pdf')).not.toBeNull()
})
