import { expect, test } from 'vitest'
import { JSDOM } from 'jsdom'
import React from 'react'
import type { ConversationRevertInput, ConversationRewindInput } from '../../../../../shared/conversation-runtime'
import type { TranscriptEntry } from './conversationProjection'
import type { EditFromHereDraft } from './editFromHere'
import type { ConversationTransport } from './conversationTransport'
import { installStudioLoopback } from '../../../../../../tests/studio-chat-loopback'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>

const FILE = { path: 'src/app.ts', status: 'modified' as const, addedLines: 2, removedLines: 1, binary: false }

async function mount(entry: UserEntry, options: { canRestoreFiles: boolean; rewindOk?: boolean; revertOk?: boolean }) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const calls: {
    reverts: ConversationRevertInput[]
    rewinds: ConversationRewindInput[]
    drafts: EditFromHereDraft[]
    order: string[]
  } = { reverts: [], rewinds: [], drafts: [], order: [] }
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationRevertToTurn: async (input: ConversationRevertInput) => {
        calls.reverts.push(input)
        if (input.confirmed) calls.order.push('restore files')
        if (input.confirmed && options.revertOk === false) return { ok: false, message: 'src/app.ts is locked.' }
        return { ok: true, files: [FILE], reverted: input.confirmed === true }
      },
    },
  })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { EditFromHereAction } = await import('./editFromHere')
  const { ConversationLinkProvider } = await import('./conversationLinks')
  const { ConversationTransportProvider, useConversationTransport } = await import('./conversationTransport')
  const { ConfirmDialogProvider } = await import('../../ui/ConfirmDialog')
  function WithRewind({ children }: { children: React.ReactNode }) {
    const local = useConversationTransport()
    const transport: ConversationTransport = {
      ...local,
      rewind: async (input) => {
        calls.rewinds.push(input)
        calls.order.push('rewind')
        return options.rewindOk === false ? { ok: false, message: 'refused' } : { ok: true }
      },
    }
    return <ConversationTransportProvider value={transport}>{children}</ConversationTransportProvider>
  }
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <ConfirmDialogProvider>
        <ConversationLinkProvider
          workspaceId="edit-test"
          workspaceRoot="/workspace/app"
          cwd="/workspace/app"
          agentId="agent"
        >
          <WithRewind>
            <EditFromHereAction
              entry={entry}
              running={false}
              canRestoreFiles={options.canRestoreFiles}
              onRestoreDraft={(draft) => calls.drafts.push(draft)}
            />
          </WithRewind>
        </ConversationLinkProvider>
      </ConfirmDialogProvider>,
    )
  })
  const buttons = (label: string) =>
    Array.from(dom.window.document.querySelectorAll('button')).filter((button) => button.textContent === label)
  const click = async (element: HTMLElement) => act(async () => element.click())
  const settle = async () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const close = async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  return { dom, calls, buttons, click, settle, close }
}

const entry: UserEntry = {
  kind: 'user',
  id: 'u1',
  seq: 7,
  text: 'Rename the helper',
  mentions: [{ kind: 'file', path: 'src/app.ts' }],
  skills: ['review'],
}

test('editing from a message restores the chosen files, goes back, and returns the message to the composer', async () => {
  const view = await mount(entry, { canRestoreFiles: true })
  try {
    await view.click(view.buttons('Edit from here')[0])
    await view.settle()
    // The dialog names what a restore would touch only once it is asked for.
    const body = view.dom.window.document.body.textContent ?? ''
    expect(body).toContain('Also restore 1 file to before this message')
    expect(body).not.toContain('src/app.ts · +2 −1')
    await view.click(view.dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
    expect(view.dom.window.document.body.textContent).toContain('src/app.ts · +2 −1')
    await view.click(view.buttons('Edit from here').at(-1)!)
    await view.settle()
    expect(view.calls.reverts).toEqual([
      { key: { workspaceRoot: '/workspace/app', workspaceId: 'edit-test', agentId: 'agent' }, turnSeq: 7 },
      {
        key: { workspaceRoot: '/workspace/app', workspaceId: 'edit-test', agentId: 'agent' },
        turnSeq: 7,
        confirmed: true,
        files: ['src/app.ts'],
      },
    ])
    expect(view.calls.rewinds).toEqual([
      { key: { workspaceRoot: '/workspace/app', workspaceId: 'edit-test', agentId: 'agent' }, turnSeq: 7 },
    ])
    expect(view.calls.drafts).toEqual([
      { text: 'Rename the helper', attachments: [], mentions: entry.mentions, skills: ['review'] },
    ])
    expect(view.calls.order, 'files move only once the conversation has').toEqual(['rewind', 'restore files'])
  } finally {
    await view.close()
  }
})

// Ticks the restore checkbox and confirms the dialog.
async function confirmWithFiles(view: Awaited<ReturnType<typeof mount>>) {
  await view.click(view.buttons('Edit from here')[0])
  await view.settle()
  await view.click(view.dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await view.click(view.buttons('Edit from here').at(-1)!)
  await view.settle()
}

test('a refused rewind restores no files', async () => {
  const { useToastStore } = await import('../../../store/toastStore')
  useToastStore.setState({ toasts: [] })
  const view = await mount(entry, { canRestoreFiles: true, rewindOk: false })
  try {
    await confirmWithFiles(view)
    expect(view.calls.order).toEqual(['rewind'])
    expect(view.calls.drafts).toEqual([])
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['Could not edit from here: refused'])
  } finally {
    await view.close()
  }
})

test('files that cannot be restored after the rewind are reported as exactly that', async () => {
  const { useToastStore } = await import('../../../store/toastStore')
  useToastStore.setState({ toasts: [] })
  const view = await mount(entry, { canRestoreFiles: true, revertOk: false })
  try {
    await confirmWithFiles(view)
    expect(view.calls.order).toEqual(['rewind', 'restore files'])
    expect(view.calls.drafts, 'the message is back in the composer all the same').toHaveLength(1)
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'The conversation went back to before this message, but its files were not restored: src/app.ts is locked.',
    ])
  } finally {
    await view.close()
  }
})

test('files stay as they are unless asked, and a refused rewind leaves the composer alone', async () => {
  const view = await mount(entry, { canRestoreFiles: false, rewindOk: false })
  try {
    await view.click(view.buttons('Edit from here')[0])
    await view.settle()
    expect(view.dom.window.document.body.textContent).toContain('Files are left as they are.')
    await view.click(view.buttons('Edit from here').at(-1)!)
    await view.settle()
    expect(view.calls.reverts).toEqual([])
    expect(view.calls.rewinds).toHaveLength(1)
    expect(view.calls.drafts).toEqual([])
  } finally {
    await view.close()
  }
})

test('images come back from the live send, or from the store when the send is gone', async () => {
  const { editFromHereDraft } = await import('./editFromHere')
  const live = { id: 'img', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 3 }
  expect((await editFromHereDraft({ ...entry, attachments: [live] }, {})).attachments).toEqual([live])
  const stored = { id: 'img', mediaType: 'image/png', byteLength: 3, ref: 'conv/img.png', name: 'shot.png' }
  const missing = { ...stored, id: 'gone', ref: 'conv/gone.png' }
  const draft = await editFromHereDraft(
    { ...entry, storedAttachments: [stored, missing] },
    {
      attachment: async ({ ref }) =>
        ref === stored.ref
          ? { ok: true, mediaType: 'image/png', dataBase64: 'AAAA' }
          : { ok: false, message: 'Not found.' },
    },
  )
  expect(draft.attachments).toEqual([{ ...live, name: 'shot.png' }])
})
