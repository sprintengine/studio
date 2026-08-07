import type { LayoutTemplate, PreviewSlot } from '../../renderer/src/types/workspace'
import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  REVIEWS_HOST_WORKSPACE_MODE,
  type WorkspaceMode,
} from '../workspace-mode'

// Layout templates live in `shared` (MC-2158) because main mints workspaces
// now: a headless `workspace.create` — the gateway, an automation, the
// scheduler, a phone — must produce a fully-formed record, and a workspace with
// no layout is not fully formed. They were always plain FlexLayout `IJsonModel`
// data with a single type-only import, so this is a relocation, not a rewrite.
// `src/renderer/src/layouts/templates.ts` re-exports them so existing renderer
// import sites are unchanged.

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
// An intentionally empty layout: no tabset, no seeded agent. Creating a
// workspace from this template lands directly on the WorkspaceLauncher
// (countOpenTabs === 0), so "New chat" opens the launcher chooser rather than
// spawning an agent outright. Kept out of LAYOUT_TEMPLATES so it never appears
// in the New Workspace template picker.
export const EMPTY_CHAT_TEMPLATE: LayoutTemplate = {
  id: 'empty-chat',
  name: 'New chat',
  description: 'Start from the launcher and choose what to spawn.',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: { type: 'row', children: [] },
  },
}

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

// ---------------------------------------------------------------------------
// Headless template resolution (MC-2158)
// ---------------------------------------------------------------------------

// The single-surface host layouts, as plain data. Their renderer registrations
// (`switchboard-workspace-types.ts`, `automations-workspace-types.ts`,
// `review/door/reviewsHostWorkspace.ts`) own the picker entry, icon, and
// creation steps; the LAYOUT is duplicated nowhere — those modules import from
// here so a host minted headlessly and a host minted from a window get the same
// tabset, tab component, and strip visibility.

const singleSurfaceLayout = (tab: Record<string, unknown>): LayoutTemplate['layout'] => ({
  global: { tabSetEnableDrop: true, tabEnableClose: true },
  borders: [],
  layout: {
    type: 'row',
    children: [{ type: 'tabset', weight: 100, enableTabStrip: false, children: [tab] }],
  },
})

export const SWITCHBOARD_TEMPLATE: LayoutTemplate = {
  id: 'switchboard-mode',
  name: 'Switchboard Mode',
  description: 'Watchtower triage inbox and the durable Switchboard task board.',
  previewSlots: [editor('Switchboard', 4, 4, 292, 102)],
  layout: singleSurfaceLayout({
    type: 'tab',
    name: 'Switchboard',
    component: 'switchboard-workspace',
    enableClose: false,
  }),
}

export const AUTOMATIONS_HOST_TEMPLATE: LayoutTemplate = {
  id: 'automations-mode',
  name: 'Automations Mode',
  description: 'Schedule agents on this project, watch run history, and manage triggers — with runs hosted as live terminals beside the control panel.',
  previewSlots: [editor('Automations', 4, 4, 292, 102)],
  layout: singleSurfaceLayout({
    type: 'tab',
    name: 'Automations',
    component: 'automations-control-center',
    enableClose: false,
  }),
}

// Rail-hidden and never user-created, so this template is only ever the shape of
// an empty workspace: guide tabs are added to it one at a time as reviews run.
export const REVIEWS_HOST_TEMPLATE: LayoutTemplate = {
  id: 'reviews-host-mode',
  name: 'Reviews',
  description: 'Hosts the review guide terminals for one project.',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: { type: 'row', children: [] },
  },
}

/** The template a workspace of this mode is minted from when none is named. */
export function defaultTemplateForWorkspaceMode(mode: WorkspaceMode | undefined): LayoutTemplate | null {
  switch (mode) {
    case 'switchboard':
      return SWITCHBOARD_TEMPLATE
    case AUTOMATIONS_HOST_WORKSPACE_MODE:
      return AUTOMATIONS_HOST_TEMPLATE
    case REVIEWS_HOST_WORKSPACE_MODE:
      return REVIEWS_HOST_TEMPLATE
    default:
      return null
  }
}

/**
 * Resolve the layout a headless `workspace.create` mints from. The mode wins
 * over a caller-named template id: a caller that asks for an automations host
 * and a 'solo' template means the host, and minting the solo layout would
 * produce a host with no control centre in it.
 *
 * An unknown template id falls back to the standard template rather than
 * failing — the id is a presentation choice, and refusing a workspace over it
 * would make the gateway brittle for callers that named a renderer-registered
 * module type main does not know about.
 */
export function resolveHeadlessLayoutTemplate(input: {
  templateId?: string | null
  mode?: WorkspaceMode | null
}): LayoutTemplate {
  const byMode = defaultTemplateForWorkspaceMode(input.mode ?? undefined)
  if (byMode) return byMode
  const templateId = input.templateId?.trim()
  if (templateId) {
    const named = [...LAYOUT_TEMPLATES, EMPTY_CHAT_TEMPLATE, SWITCHBOARD_TEMPLATE, AUTOMATIONS_HOST_TEMPLATE, REVIEWS_HOST_TEMPLATE]
      .find((template) => template.id === templateId)
    if (named) return named
  }
  return DEFAULT_LAYOUT_TEMPLATE
}

/** The template a workspace created with no explicit choice lands on. */
export const DEFAULT_LAYOUT_TEMPLATE: LayoutTemplate = LAYOUT_TEMPLATES[0]
