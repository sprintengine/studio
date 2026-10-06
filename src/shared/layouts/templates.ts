import type { LayoutTemplate, PreviewSlot } from '../../renderer/src/types/workspace'

// Layout templates live in `shared` because main mints workspaces
// now: a headless `workspace.create` — the gateway, a scheduled agent's run,
// a phone — must produce a fully-formed record, and a workspace with
// no layout is not fully formed. They were always plain FlexLayout `IJsonModel`
// data with a single type-only import, so this is a relocation, not a rewrite.
// `src/renderer/src/layouts/templates.ts` re-exports them so existing renderer
// import sites are unchanged.

// Helpers to keep preview slot definitions readable.
// Previews are rendered in a 300×110 viewBox.
const agent = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({
  x,
  y,
  w,
  h,
  type: 'agent',
  label,
})
const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({
  x,
  y,
  w,
  h,
  type: 'editor',
  label,
})

// flexlayout shortcuts
const agentTab = (id: string, name = id) => ({
  type: 'tab',
  name,
  component: 'agent',
  config: { agentId: id },
})
const editorTab = { type: 'tab', name: 'Editor', component: 'editor' }
// Files is not a layout component any more: it is a workspace-pane tab
// (browser-pane epic), opened from the identity chip or the pane's "+", so no
// template docks it. The dev templates start on editor + agents.
// An intentionally empty layout: no tabset, no seeded agent. Creating a
// workspace from this template lands on WorkspaceLayout's empty-workspace rule
// (countOpenTabs === 0), which opens the New chat launch surface in the tab its
// agent will run in — so "New chat" chooses what to spawn rather than spawning
// outright. Kept out of LAYOUT_TEMPLATES so it never appears in the New
// Workspace template picker.
export const EMPTY_CHAT_TEMPLATE: LayoutTemplate = {
  id: 'empty-chat',
  name: 'New chat',
  description: 'Start on the New chat surface and choose what to spawn.',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: { type: 'row', children: [] },
  },
}

/**
 * The template a New chat is minted from, and the template's own name for its
 * one agent. That name is a placeholder, never a chat's agent id: making a
 * workspace from a template gives each of its agents a fresh id
 * (`instantiateTemplateAgentIds`), so the agent ids in these layouts recur in
 * no workspace. A caller that mints its agent first (main's new chat) names it
 * for this placeholder, so the tab and the agent record agree from the first
 * event.
 */
export const SOLO_CHAT_TEMPLATE_ID = 'solo'
export const SOLO_CHAT_TEMPLATE_AGENT_ID = 'agent-1'

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: SOLO_CHAT_TEMPLATE_ID,
    name: 'Solo',
    description: 'Single AI terminal for focused work.',
    previewSlots: [agent('Agent', 4, 4, 292, 102)],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [{ type: 'tabset', weight: 100, children: [agentTab(SOLO_CHAT_TEMPLATE_AGENT_ID, 'Agent')] }],
      },
    },
  },
  {
    id: 'duo',
    name: 'Duo',
    description: 'Two AI terminals side by side.',
    previewSlots: [agent('Agent 1', 4, 4, 144, 102), agent('Agent 2', 152, 4, 144, 102)],
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
    description: 'Editor and one AI terminal.',
    previewSlots: [editor('Editor', 4, 4, 196, 102), agent('Agent', 204, 4, 92, 102)],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 66, children: [editorTab] },
          { type: 'tabset', weight: 34, children: [agentTab('agent-1', 'Agent')] },
        ],
      },
    },
  },
  {
    id: 'duo-dev',
    name: 'Duo Dev',
    description: 'Editor flow with two stacked AI terminals.',
    previewSlots: [
      editor('Editor', 4, 4, 196, 102),
      agent('Agent 1', 204, 4, 92, 49),
      agent('Agent 2', 204, 57, 92, 49),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 66, children: [editorTab] },
          {
            type: 'row',
            weight: 34,
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
      editor('Editor', 4, 4, 146, 102),
      agent('A1', 154, 4, 69, 49),
      agent('A3', 154, 57, 69, 49),
      agent('A2', 227, 4, 69, 49),
      agent('A4', 227, 57, 69, 49),
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', weight: 52, children: [editorTab] },
          {
            type: 'row',
            weight: 48,
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
      agent('A1', 4, 4, 94, 32),
      agent('A2', 104, 4, 94, 32),
      agent('A3', 204, 4, 92, 32),
      agent('A4', 4, 40, 94, 32),
      agent('A5', 104, 40, 94, 32),
      agent('A6', 204, 40, 92, 32),
      agent('A7', 4, 76, 94, 30),
      agent('A8', 104, 76, 94, 30),
      agent('A9', 204, 76, 92, 30),
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

// ---------------------------------------------------------------------------
// Headless template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the layout a headless `workspace.create` mints from.
 *
 * An unknown template id falls back to the standard template rather than
 * failing — the id is a presentation choice, and refusing a workspace over it
 * would make the gateway brittle for callers that named a renderer-registered
 * module type main does not know about.
 */
export function resolveHeadlessLayoutTemplate(input: { templateId?: string | null }): LayoutTemplate {
  const templateId = input.templateId?.trim()
  if (templateId) {
    const named = [...LAYOUT_TEMPLATES, EMPTY_CHAT_TEMPLATE].find((template) => template.id === templateId)
    if (named) return named
  }
  return DEFAULT_LAYOUT_TEMPLATE
}

/** The template a workspace created with no explicit choice lands on. */
const DEFAULT_LAYOUT_TEMPLATE: LayoutTemplate = LAYOUT_TEMPLATES[0]
