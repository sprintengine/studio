import type { LayoutTemplate, PreviewSlot } from '../types/workspace'

// Helpers to keep preview slot definitions readable.
// Previews are rendered in a 300×110 viewBox.
const agent = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'agent', label })
const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })
const files = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'explorer', label })

// flexlayout shortcuts
const agentTab = (id: string, name = id) => ({
  type: 'tab',
  name,
  component: 'agent',
  config: { agentId: id },
})
const editorTab = { type: 'tab', name: 'Editor', component: 'editor' }
const explorerTab = { type: 'tab', name: 'Files', component: 'explorer' }
// Files / Git / Knowledge Graph are exclusive strip-less nav switches driven by
// the sidebar PanelRail, so the tabset holding the explorer hides its strip.
const navRailTabset = (weight: number) => ({
  type: 'tabset',
  weight,
  enableTabStrip: false,
  children: [explorerTab],
})
export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'solo',
    name: 'Solo',
    description: 'Single AI terminal for focused work.',
    previewSlots: [agent('Agent', 4, 4, 292, 102)],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 100, children: [agentTab('agent-1', 'Agent')] },
        ],
      },
    },
  },
  {
    id: 'duo',
    name: 'Duo',
    description: 'Two AI terminals side by side.',
    previewSlots: [
      agent('Agent 1', 4, 4, 144, 102),
      agent('Agent 2', 152, 4, 144, 102),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 50, children: [agentTab('agent-1', 'Agent 1')] },
          { type: 'tabset', weight: 50, children: [agentTab('agent-2', 'Agent 2')] },
        ],
      },
    },
  },
  {
    id: 'solo-dev',
    name: 'Solo Dev',
    description: 'Explorer, editor, and one AI terminal.',
    previewSlots: [
      files('Files', 4, 4, 56, 102),
      editor('Editor', 64, 4, 148, 102),
      agent('Agent', 216, 4, 80, 102),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          navRailTabset(18),
          { type: 'tabset', weight: 52, children: [editorTab] },
          { type: 'tabset', weight: 30, children: [agentTab('agent-1', 'Agent')] },
        ],
      },
    },
  },
  {
    id: 'duo-dev',
    name: 'Duo Dev',
    description: 'Editor flow with two stacked AI terminals.',
    previewSlots: [
      files('Files', 4, 4, 56, 102),
      editor('Editor', 64, 4, 148, 102),
      agent('Agent 1', 216, 4, 80, 49),
      agent('Agent 2', 216, 57, 80, 49),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          navRailTabset(18),
          { type: 'tabset', weight: 52, children: [editorTab] },
          {
            type: 'row',
            weight: 30,
            children: [
              { type: 'tabset', weight: 50, children: [agentTab('agent-1', 'Agent 1')] },
              { type: 'tabset', weight: 50, children: [agentTab('agent-2', 'Agent 2')] },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'quad-dev',
    name: 'Quad Dev',
    description: 'Editor plus four visible AI terminals.',
    previewSlots: [
      files('Files', 4, 4, 50, 102),
      editor('Editor', 58, 4, 140, 102),
      agent('A1', 202, 4, 44, 49),
      agent('A3', 202, 57, 44, 49),
      agent('A2', 250, 4, 46, 49),
      agent('A4', 250, 57, 46, 49),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          navRailTabset(16),
          { type: 'tabset', weight: 44, children: [editorTab] },
          {
            type: 'row',
            weight: 40,
            children: [
              {
                type: 'row',
                weight: 50,
                children: [
                  { type: 'tabset', weight: 50, children: [agentTab('agent-1', 'Agent 1')] },
                  { type: 'tabset', weight: 50, children: [agentTab('agent-3', 'Agent 3')] },
                ],
              },
              {
                type: 'row',
                weight: 50,
                children: [
                  { type: 'tabset', weight: 50, children: [agentTab('agent-2', 'Agent 2')] },
                  { type: 'tabset', weight: 50, children: [agentTab('agent-4', 'Agent 4')] },
                ],
              },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'command-center',
    name: 'Command Center',
    description: 'Nine tiled AI terminals in a dense grid.',
    previewSlots: [
      agent('A1', 4, 4, 94, 32),     agent('A2', 104, 4, 94, 32),    agent('A3', 204, 4, 92, 32),
      agent('A4', 4, 40, 94, 32),    agent('A5', 104, 40, 94, 32),   agent('A6', 204, 40, 92, 32),
      agent('A7', 4, 76, 94, 30),    agent('A8', 104, 76, 94, 30),   agent('A9', 204, 76, 92, 30),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'row',
            weight: 33,
            children: [
              { type: 'tabset', weight: 33, children: [agentTab('agent-1', 'A1')] },
              { type: 'tabset', weight: 33, children: [agentTab('agent-4', 'A4')] },
              { type: 'tabset', weight: 33, children: [agentTab('agent-7', 'A7')] },
            ],
          },
          {
            type: 'row',
            weight: 33,
            children: [
              { type: 'tabset', weight: 33, children: [agentTab('agent-2', 'A2')] },
              { type: 'tabset', weight: 33, children: [agentTab('agent-5', 'A5')] },
              { type: 'tabset', weight: 33, children: [agentTab('agent-8', 'A8')] },
            ],
          },
          {
            type: 'row',
            weight: 33,
            children: [
              { type: 'tabset', weight: 33, children: [agentTab('agent-3', 'A3')] },
              { type: 'tabset', weight: 33, children: [agentTab('agent-6', 'A6')] },
              { type: 'tabset', weight: 33, children: [agentTab('agent-9', 'A9')] },
            ],
          },
        ],
      },
    },
  },
]
