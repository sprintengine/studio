import { ipcRenderer } from 'electron'
import {
  BROWSER_MAX_OUTER_HTML,
  BROWSER_PICK_CANCELLED_CHANNEL,
  BROWSER_PICK_START_CHANNEL,
  BROWSER_PICK_STOP_CHANNEL,
  BROWSER_PICKED_CHANNEL,
  type BrowserPickTheme,
  type BrowserPickedElement,
} from '../shared/browser'

// The browser guest's preload (browser-pane epic): the element picker. It
// runs sandboxed (no Node) in the page's own world so it can read React's
// fiber off DOM nodes, and it puts NOTHING on `window` — every reference,
// `ipcRenderer` included, stays in this closure. The host renderer starts and
// stops it over the webview channel; a pick is reported back the same way.

const STYLE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'font',
  'color',
  'background-color',
  'border-radius',
  'border',
  'opacity',
] as const

let overlay: { host: HTMLElement; box: HTMLElement; chip: HTMLElement } | null = null
let target: Element | null = null
let theme: BrowserPickTheme | null = null

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

// A stable selector: an id, a test id, a name, else a short nth-of-type path.
function selectorFor(element: Element): string {
  if (element.id) return `#${cssEscape(element.id)}`
  const testId = element.getAttribute('data-testid')
  if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`
  const name = element.getAttribute('name')
  if (name && element.tagName !== 'META') return `${element.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`
  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== document.documentElement && parts.length < 8) {
    const tag = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName)
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag)
    if (parent.id) {
      parts.unshift(`#${cssEscape(parent.id)}`)
      break
    }
    node = parent
  }
  return parts.join(' > ')
}

// `_debugSource` is React 16–18's dev-only source location. React 19 removed
// it (the info moved to the component stack), so `source` is null on a React
// 19 dev server — expected, not a bug to chase.
type Fiber = {
  type?: unknown
  return?: Fiber | null
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null
  _debugOwner?: Fiber | null
}

function fiberOf(element: Element): Fiber | null {
  for (const key of Object.keys(element)) {
    if (key.startsWith('__reactFiber$')) return (element as unknown as Record<string, Fiber>)[key] ?? null
  }
  return null
}

function componentName(type: unknown): string | null {
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string }
    return fn.displayName || fn.name || null
  }
  if (type && typeof type === 'object') {
    const wrapped = type as { displayName?: string; render?: { displayName?: string; name?: string }; type?: unknown }
    if (wrapped.displayName) return wrapped.displayName
    if (wrapped.render) return wrapped.render.displayName || wrapped.render.name || null
    if (wrapped.type) return componentName(wrapped.type)
  }
  return null
}

function reactContext(element: Element): { components: string[]; source: string | null } {
  const components: string[] = []
  let source: string | null = null
  let fiber = fiberOf(element)
  let hops = 0
  while (fiber && hops < 40 && components.length < 3) {
    const name = componentName(fiber.type)
    if (name) components.push(name)
    const debug = fiber._debugSource
    if (!source && debug?.fileName) {
      source = `${debug.fileName}${debug.lineNumber ? `:${debug.lineNumber}` : ''}${debug.columnNumber ? `:${debug.columnNumber}` : ''}`
    }
    fiber = fiber.return ?? null
    hops += 1
  }
  return { components, source }
}

function serialize(element: Element): BrowserPickedElement {
  const rect = element.getBoundingClientRect()
  const computed = getComputedStyle(element)
  const styles: Record<string, string> = {}
  for (const key of STYLE_KEYS) {
    const value = computed.getPropertyValue(key)
    if (value) styles[key] = value
  }
  const { components, source } = reactContext(element)
  return {
    url: location.href,
    title: document.title,
    selector: selectorFor(element),
    tagName: element.tagName.toLowerCase(),
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    outerHtml: element.outerHTML.slice(0, BROWSER_MAX_OUTER_HTML),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    styles,
    components,
    source,
  }
}

function ensureOverlay(): { host: HTMLElement; box: HTMLElement; chip: HTMLElement } {
  if (overlay) return overlay
  const host = document.createElement('div')
  host.setAttribute('data-sprintengine-picker', '')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;'
  // Closed shadow root: the page can neither see nor restyle the overlay.
  const shadow = host.attachShadow({ mode: 'closed' })
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;box-sizing:border-box;pointer-events:none;border:1px solid transparent;'
  const chip = document.createElement('div')
  chip.style.cssText =
    'position:fixed;pointer-events:none;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'padding:2px 6px;border-radius:3px;border:1px solid transparent;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;'
  shadow.append(box, chip)
  document.documentElement.append(host)
  overlay = { host, box, chip }
  return overlay
}

function paint(element: Element | null): void {
  if (!overlay || !theme) return
  const { box, chip } = overlay
  if (!element) {
    box.style.display = 'none'
    chip.style.display = 'none'
    return
  }
  const rect = element.getBoundingClientRect()
  box.style.display = 'block'
  box.style.left = `${rect.left}px`
  box.style.top = `${rect.top}px`
  box.style.width = `${rect.width}px`
  box.style.height = `${rect.height}px`
  box.style.borderColor = theme.accent
  box.style.background = theme.accentSoft
  const id = element.id ? `#${element.id}` : ''
  const classes = Array.from(element.classList).slice(0, 2).map((name) => `.${name}`).join('')
  chip.textContent = `${element.tagName.toLowerCase()}${id}${classes} · ${Math.round(rect.width)} × ${Math.round(rect.height)}`
  chip.style.display = 'block'
  chip.style.background = theme.chipBackground
  chip.style.borderColor = theme.chipBorder
  chip.style.color = theme.chipText
  const chipTop = rect.top - 24 >= 0 ? rect.top - 24 : rect.bottom + 4
  chip.style.left = `${Math.max(0, rect.left)}px`
  chip.style.top = `${chipTop}px`
}

function elementAt(event: MouseEvent): Element | null {
  const found = document.elementFromPoint(event.clientX, event.clientY)
  if (!found || found === document.documentElement || found === document.body) return null
  if (overlay && (found === overlay.host || overlay.host.contains(found))) return null
  return found
}

function onMove(event: MouseEvent): void {
  target = elementAt(event)
  paint(target)
}

function onClick(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const picked = elementAt(event) ?? target
  if (!picked) return
  const payload = serialize(picked)
  stop()
  ipcRenderer.sendToHost(BROWSER_PICKED_CHANNEL, payload)
}

function swallow(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    stop()
    ipcRenderer.sendToHost(BROWSER_PICK_CANCELLED_CHANNEL)
  }
}

let listening = false

function start(nextTheme: BrowserPickTheme): void {
  theme = nextTheme
  ensureOverlay()
  if (listening) return
  listening = true
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('mousedown', swallow, true)
  document.addEventListener('mouseup', swallow, true)
  document.addEventListener('keydown', onKey, true)
  document.documentElement.style.cursor = 'crosshair'
}

function stop(): void {
  if (!listening) return
  listening = false
  document.removeEventListener('mousemove', onMove, true)
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('mousedown', swallow, true)
  document.removeEventListener('mouseup', swallow, true)
  document.removeEventListener('keydown', onKey, true)
  document.documentElement.style.cursor = ''
  target = null
  paint(null)
}

ipcRenderer.on(BROWSER_PICK_START_CHANNEL, (_event, nextTheme: BrowserPickTheme) => start(nextTheme))
ipcRenderer.on(BROWSER_PICK_STOP_CHANNEL, () => stop())

// A navigation tears the picker down with the document; the host learns of
// it through the tab's own state, so nothing to report here.
window.addEventListener('pagehide', () => stop())
