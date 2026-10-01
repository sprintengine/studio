// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { CanvasExportDialog } from './CanvasExportDialog'
import type { CanvasExportFormats } from './canvasExport'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function render(props: Partial<React.ComponentProps<typeof CanvasExportDialog>> = {}) {
  const onExport = vi.fn<(formats: CanvasExportFormats) => void>()
  const onCancel = vi.fn()
  const element = (
    <CanvasExportDialog
      open
      boardName="architecture"
      pending={false}
      error={null}
      onCancel={onCancel}
      onExport={onExport}
      {...props}
    />
  )
  return { element, onExport, onCancel }
}

function checkbox(label: string): HTMLInputElement {
  const input = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((candidate) =>
    candidate.closest('label')?.textContent?.includes(label),
  )
  if (!input) throw new Error(`no checkbox for ${label}`)
  return input
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

test('the board file is always exported, and the pictures are off until asked for', async () => {
  const { element, onExport } = render()
  await act(async () => root.render(element))

  expect(document.body.textContent).toContain('Export architecture')
  expect(document.body.textContent).toContain('architecture.excalidraw')
  expect(checkbox('Board file').checked).toBe(true)
  expect(checkbox('Board file').disabled).toBe(true)
  expect(checkbox('PNG image').checked).toBe(false)
  expect(checkbox('SVG image').checked).toBe(false)

  await act(async () => button('Choose folder and export').click())
  expect(onExport).toHaveBeenCalledWith({ png: false, svg: false })
})

test('a ticked picture rides along with the export', async () => {
  const { element, onExport } = render()
  await act(async () => root.render(element))
  await act(async () => checkbox('PNG image').click())
  await act(async () => button('Choose folder and export').click())
  expect(onExport).toHaveBeenCalledWith({ png: true, svg: false })
})

test('a failed export is said in the dialog, which stays open to try again', async () => {
  const { element } = render({ error: 'EACCES: permission denied' })
  await act(async () => root.render(element))
  expect(document.body.textContent).toContain('The board was not exported')
  expect(document.body.textContent).toContain('EACCES: permission denied')
  expect(button('Choose folder and export').disabled).toBe(false)
})

test('while an export runs, nothing in the dialog can be changed or pressed twice', async () => {
  const { element, onExport } = render({ pending: true })
  await act(async () => root.render(element))
  expect(button('Exporting…').disabled).toBe(true)
  expect(button('Cancel').disabled).toBe(true)
  expect(checkbox('PNG image').disabled).toBe(true)
  await act(async () => button('Exporting…').click())
  expect(onExport).not.toHaveBeenCalled()
})
