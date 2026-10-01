import type { RegisterRenderer } from '@sprintengine/module-sdk'

import { createNotesPanel } from './NotesPanel'

const PANEL_ID = '{{id}}.notes'
const WORKSPACE_TYPE_ID = '{{id}}'

function NotesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M6 4h9l3 3v13H6z" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </svg>
  )
}

// A panel only appears where a layout places it, so this module also registers
// a small workspace type whose one tab is the panel. `openOnFirstLoad` opens
// that workspace the first time the module loads; the command reopens it.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerPanel(PANEL_ID, createNotesPanel(host))
  host.registerWorkspaceType({
    id: WORKSPACE_TYPE_ID,
    label: '{{displayName}}',
    description: 'A scratchpad that keeps what you write.',
    icon: NotesIcon,
    openOnFirstLoad: true,
    createTemplate: () => ({
      id: WORKSPACE_TYPE_ID,
      name: '{{displayName}}',
      description: 'One notes panel.',
      previewSlots: [{ x: 0, y: 0, w: 1, h: 1, type: 'editor', label: 'Notes' }],
      layout: {
        layout: {
          type: 'row',
          children: [{ type: 'tabset', children: [{ type: 'tab', name: 'Notes', component: PANEL_ID }] }],
        },
      },
    }),
  })
  host.registerCommand({
    id: 'open',
    title: 'Open {{displayName}}',
    category: '{{displayName}}',
    scopes: ['global'],
    async run() {
      await host.openWorkspace(WORKSPACE_TYPE_ID)
    },
  })
}
