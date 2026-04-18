import type { LayoutTemplate } from '../types/workspace'

// Each template is a flexlayout-react JSON model — this IS the template system.
// To add a new template, add an entry here; no other code changes needed.
export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'File explorer + code editor + 4 agents in a 2×2 grid',
    previewSlots: [
      { x: 2,   y: 2,  w: 46,  h: 116, type: 'explorer', label: 'Explorer' },
      { x: 52,  y: 2,  w: 128, h: 116, type: 'editor',   label: 'Editor'   },
      { x: 184, y: 2,  w: 54,  h: 56,  type: 'agent',    label: 'Agent 1'  },
      { x: 242, y: 2,  w: 56,  h: 56,  type: 'agent',    label: 'Agent 2'  },
      { x: 184, y: 62, w: 54,  h: 56,  type: 'agent',    label: 'Agent 3'  },
      { x: 242, y: 62, w: 56,  h: 56,  type: 'agent',    label: 'Agent 4'  },
    ],
    layout: {
      global: { tabSetEnableDrop: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 15,
            children: [{ type: 'tab', name: 'Explorer', component: 'explorer' }],
          },
          {
            type: 'tabset',
            weight: 45,
            children: [{ type: 'tab', name: 'Editor', component: 'editor' }],
          },
          {
            type: 'row',
            weight: 40,
            children: [
              {
                type: 'row',
                weight: 50,
                children: [
                  { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 1', component: 'agent', config: { agentId: 'agent-1' } }] },
                  { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 2', component: 'agent', config: { agentId: 'agent-2' } }] },
                ],
              },
              {
                type: 'row',
                weight: 50,
                children: [
                  { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 3', component: 'agent', config: { agentId: 'agent-3' } }] },
                  { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 4', component: 'agent', config: { agentId: 'agent-4' } }] },
                ],
              },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'agents-only',
    name: 'Agents Only',
    description: '4 agents in a 2×2 grid — no editor or explorer',
    previewSlots: [
      { x: 2,   y: 2,  w: 144, h: 56, type: 'agent', label: 'Agent 1' },
      { x: 154, y: 2,  w: 144, h: 56, type: 'agent', label: 'Agent 2' },
      { x: 2,   y: 62, w: 144, h: 56, type: 'agent', label: 'Agent 3' },
      { x: 154, y: 62, w: 144, h: 56, type: 'agent', label: 'Agent 4' },
    ],
    layout: {
      global: { tabSetEnableDrop: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'row',
            weight: 50,
            children: [
              { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 1', component: 'agent', config: { agentId: 'agent-1' } }] },
              { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 2', component: 'agent', config: { agentId: 'agent-2' } }] },
            ],
          },
          {
            type: 'row',
            weight: 50,
            children: [
              { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 3', component: 'agent', config: { agentId: 'agent-3' } }] },
              { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 4', component: 'agent', config: { agentId: 'agent-4' } }] },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'split-view',
    name: 'Split View',
    description: '2 full-height vertical agent panels',
    previewSlots: [
      { x: 2,   y: 2, w: 146, h: 116, type: 'agent', label: 'Agent 1' },
      { x: 152, y: 2, w: 146, h: 116, type: 'agent', label: 'Agent 2' },
    ],
    layout: {
      global: { tabSetEnableDrop: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 1', component: 'agent', config: { agentId: 'agent-1' } }] },
          { type: 'tabset', weight: 50, children: [{ type: 'tab', name: 'Agent 2', component: 'agent', config: { agentId: 'agent-2' } }] },
        ],
      },
    },
  },
  {
    id: 'focus',
    name: 'Focus View',
    description: 'One maximized agent panel — full concentration mode',
    previewSlots: [
      { x: 2, y: 2, w: 296, h: 116, type: 'agent', label: 'Agent' },
    ],
    layout: {
      global: { tabSetEnableDrop: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 100, children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'agent-1' } }] },
        ],
      },
    },
  },
]
