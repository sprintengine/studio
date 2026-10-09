// `@sprintengine/module-sdk/testing/kit` — a stand-in for the host's UI kit
// and door shell that DRAWS, for tests that render a module's components in
// Node.
//
// The real `/ui` and `/surface` are provided by the app at runtime, and the
// SDK's own copies throw the moment they load (so a bundle that inlined them
// fails loudly). A test that renders a door needs something in their place
// that keeps the module's own markup visible. Every component here renders a
// `<div data-kit="Name">` holding what it was given:
//
// - `children`, and any prop that is a React element (`action`, `glyph`,
//   `rail`, …), rendered as they are;
// - text-like props (`title`, `label`, `message`, `body`, `hint`, …) as text,
//   so `assert.match(html, /Nothing yet/)` finds an empty state's title;
// - other strings, numbers and booleans as `data-*` attributes;
// - objects and arrays (a rail's `rows`, a select's `items`, the shell's
//   `bar`) one level down, the same way.
//
// `installTestingKit()` from `@sprintengine/module-sdk/testing` routes the
// host-provided specifiers here; `renderToHtml` renders with it. The export
// list is the host's (`/ui`, `/surface`, and `@monaco-editor/react`'s
// `Editor`, `DiffEditor` and default): the drift guard in the app repository
// fails when a component is published without a stand-in here.

import { createElement, Fragment, isValidElement, type ReactNode } from 'react'

import type * as surface from './surface.js'
import type * as ui from './ui.js'

// Props whose string value is what the person reads, drawn as text.
const TEXT_PROPS = new Set([
  'title',
  'label',
  'subtitle',
  'message',
  'body',
  'hint',
  'detail',
  'help',
  'error',
  'description',
  'stateLine',
  'retryLabel',
  'placeholder',
  'count',
  // SafeMarkdown's source, and a TaskCard's key and supporting line.
  'text',
  'identifier',
  'supporting',
])
// Props that only style or wire up; never drawn.
const SKIPPED_PROPS = new Set(['className', 'style', 'ref', 'key', 'children'])
const MAX_DEPTH = 3

function attributeName(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/[^a-z0-9-]/g, '')}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isValidElement(value)
}

// What one prop contributes to the drawing: nodes for the body, or an attribute.
function drawProp(key: string, value: unknown, depth: number, attributes: Record<string, string>): ReactNode[] {
  if (value === undefined || value === null || value === false || typeof value === 'function') return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    attributes[attributeName(key)] = String(value)
    return TEXT_PROPS.has(key) && typeof value !== 'boolean'
      ? [createElement('span', { key, 'data-prop': key }, String(value))]
      : []
  }
  if (isValidElement(value)) return [createElement('span', { key, 'data-prop': key }, value)]
  if (depth >= MAX_DEPTH) return []
  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      isValidElement(item) || typeof item === 'string' || typeof item === 'number'
        ? createElement(Fragment, { key: index }, item)
        : isPlainObject(item)
          ? drawObject(`${key}-${index}`, item, depth + 1)
          : null,
    )
    return items.length > 0 ? [createElement('div', { key, 'data-prop': key }, ...items)] : []
  }
  if (isPlainObject(value)) return [drawObject(key, value, depth + 1)]
  return []
}

function drawObject(key: string, value: Record<string, unknown>, depth: number): ReactNode {
  const attributes: Record<string, string> = {}
  const body: ReactNode[] = []
  for (const [name, entry] of Object.entries(value)) body.push(...drawProp(name, entry, depth, attributes))
  return createElement('div', { key, 'data-prop': key, ...attributes }, ...body)
}

type AnyProps = Record<string, unknown> & { children?: ReactNode }

function passThrough(name: string): (props: AnyProps) => ReactNode {
  const Component = (props: AnyProps): ReactNode => {
    const attributes: Record<string, string> = {}
    const body: ReactNode[] = []
    for (const [key, value] of Object.entries(props)) {
      if (SKIPPED_PROPS.has(key)) continue
      body.push(...drawProp(key, value, 0, attributes))
    }
    return createElement('div', { 'data-kit': name, ...attributes }, ...body, props.children)
  }
  Component.displayName = name
  return Component
}

// A drawer is drawn only while it is open, as the host's is.
function drawer(props: AnyProps): ReactNode {
  return props.open ? passThrough('Drawer')(props) : null
}

// Each stand-in carries the SDK's own declared type, so code that imports this
// module typechecks exactly as the module's source does against `/ui`.
const stand = <T>(component: unknown): T => component as T

// ── @sprintengine/module-sdk/ui ──────────────────────────────────────────────

export const FOCUS_RING_CLASS: typeof ui.FOCUS_RING_CLASS = ''
export const PrimaryButton = stand<typeof ui.PrimaryButton>(passThrough('PrimaryButton'))
export const GhostButton = stand<typeof ui.GhostButton>(passThrough('GhostButton'))
export const OutlineButton = stand<typeof ui.OutlineButton>(passThrough('OutlineButton'))
export const LinkButton = stand<typeof ui.LinkButton>(passThrough('LinkButton'))
export const RowButton = stand<typeof ui.RowButton>(passThrough('RowButton'))
export const Input = stand<typeof ui.Input>(passThrough('Input'))
export const Textarea = stand<typeof ui.Textarea>(passThrough('Textarea'))
export const Field = stand<typeof ui.Field>(passThrough('Field'))
export const Select = stand<typeof ui.Select>(passThrough('Select'))
export const SegmentedControl = stand<typeof ui.SegmentedControl>(passThrough('SegmentedControl'))
export const PanelHeader = stand<typeof ui.PanelHeader>(passThrough('PanelHeader'))
export const Banner = stand<typeof ui.Banner>(passThrough('Banner'))
export const InlineNotice = stand<typeof ui.InlineNotice>(passThrough('InlineNotice'))
export const EmptyState = stand<typeof ui.EmptyState>(passThrough('EmptyState'))
export const Spinner = stand<typeof ui.Spinner>(passThrough('Spinner'))
export const StatusDot = stand<typeof ui.StatusDot>(passThrough('StatusDot'))
export const LifecycleGlyph = stand<typeof ui.LifecycleGlyph>(passThrough('LifecycleGlyph'))
export const Section = stand<typeof ui.Section>(passThrough('Section'))
export const Drawer = stand<typeof ui.Drawer>(Object.assign(drawer, { Body: passThrough('Drawer.Body') }))
export const TruncatedText = stand<typeof ui.TruncatedText>(passThrough('TruncatedText'))
export const KbdChord = stand<typeof ui.KbdChord>(passThrough('KbdChord'))
export const CliModelPickerButton = stand<typeof ui.CliModelPickerButton>(passThrough('CliModelPickerButton'))
export const DateTimeInput = stand<typeof ui.DateTimeInput>(passThrough('DateTimeInput'))
export const Toggle = stand<typeof ui.Toggle>(passThrough('Toggle'))
export const ContextMenu = stand<typeof ui.ContextMenu>(passThrough('ContextMenu'))
export const MenuItem = stand<typeof ui.MenuItem>(passThrough('MenuItem'))
export const MenuDivider = stand<typeof ui.MenuDivider>(passThrough('MenuDivider'))
export const Chip = stand<typeof ui.Chip>(passThrough('Chip'))
export const ChipButton = stand<typeof ui.ChipButton>(passThrough('ChipButton'))
export const TaskCard = stand<typeof ui.TaskCard>(passThrough('TaskCard'))
export const BoardLane = stand<typeof ui.BoardLane>(passThrough('BoardLane'))
/** Drawn as its Markdown source, as text: assert on the words, not the formatting. */
export const SafeMarkdown = stand<typeof ui.SafeMarkdown>(passThrough('SafeMarkdown'))
export const SidebarNavButton = stand<typeof ui.SidebarNavButton>(passThrough('SidebarNavButton'))

// ── @sprintengine/module-sdk/surface ─────────────────────────────────────────

export const GlobalSurfaceShell = stand<typeof surface.GlobalSurfaceShell>(passThrough('GlobalSurfaceShell'))
export const SurfaceCanvasState = stand<typeof surface.SurfaceCanvasState>(passThrough('SurfaceCanvasState'))
export const SurfaceRail = stand<typeof surface.SurfaceRail>(passThrough('SurfaceRail'))
/** No back stack outside the app: `onBack` calls `close` when given one. */
export const useSurfaceBackNav: typeof surface.useSurfaceBackNav = (close) => ({
  onBack: () => close?.(),
  canGoBack: close !== undefined,
})

// ── @monaco-editor/react ─────────────────────────────────────────────────────

/** Monaco's editor, drawn as the text it was given. */
export type EditorStandInProps = {
  value?: string
  defaultValue?: string
  original?: string
  modified?: string
  language?: string
}

function editor(name: string): (props: EditorStandInProps) => ReactNode {
  const Component = (props: EditorStandInProps): ReactNode =>
    createElement(
      'pre',
      { 'data-kit': name, ...(props.language ? { 'data-language': props.language } : {}) },
      props.value ?? props.defaultValue ?? props.modified ?? '',
    )
  Component.displayName = name
  return Component
}

export const Editor: (props: EditorStandInProps) => ReactNode = editor('Editor')
export const DiffEditor: (props: EditorStandInProps) => ReactNode = editor('DiffEditor')
export default Editor
