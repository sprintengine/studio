export type KeybindingPlatform = 'darwin' | 'windows' | 'linux'

export type KeybindingModifier = 'primary' | 'ctrl' | 'alt' | 'shift' | 'meta'

export type KeybindingStroke = {
  modifiers: readonly KeybindingModifier[]
  key: string
}

export type KeybindingChord = {
  strokes: readonly KeybindingStroke[]
  canonical: string
}

export type ParsedKeybinding =
  | { ok: true; chord: KeybindingChord }
  | { ok: false; error: string }

const MODIFIER_ALIASES: Record<string, KeybindingModifier> = {
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  option: 'alt',
  opt: 'alt',
  alt: 'alt',
  shift: 'shift',
  primary: 'primary',
  mod: 'primary',
  cmdorctrl: 'primary',
  commandorcontrol: 'primary',
}

const MODIFIER_ORDER: readonly KeybindingModifier[] = ['primary', 'ctrl', 'alt', 'shift', 'meta']
const DISPLAY_MODIFIER: Record<KeybindingModifier, string> = {
  primary: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Cmd',
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  plus: '+',
  comma: ',',
  period: '.',
  dot: '.',
  slash: '/',
  backslash: '\\',
  quote: "'",
  apostrophe: "'",
  backquote: '`',
  grave: '`',
  minus: '-',
  dash: '-',
  equal: '=',
  equals: '=',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  pageup: 'pageup',
  pagedown: 'pagedown',
}

const DISPLAY_KEY: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  backspace: 'Backspace',
  delete: 'Delete',
  enter: 'Enter',
  escape: 'Esc',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space',
  tab: 'Tab',
  '+': '+',
  '`': '`',
  "'": "'",
  '\\': '\\',
}

function splitStroke(input: string): string[] {
  const parts = input.split('+')
  const tokens = parts.map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1 && parts.at(-1)?.trim() === '') tokens.push('+')
  return tokens
}

function normalizeKeyToken(token: string): string {
  const compact = token.trim().toLowerCase().replace(/\s+/g, '')
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(compact)) return compact
  if (/^digit[0-9]$/.test(compact)) return compact.slice('digit'.length)
  if (/^key[a-z]$/.test(compact)) return compact.slice('key'.length)
  return KEY_ALIASES[compact] ?? compact
}

export function parseKeybinding(input: string): ParsedKeybinding {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'Keybinding is empty.' }

  let rawStrokes = raw
    .split(/\s+then\s+|,\s+|\s{2,}/i)
    .map((stroke) => stroke.trim())
    .filter(Boolean)
  if (rawStrokes.length === 1 && /\s/.test(raw) && !raw.includes('+')) {
    const canonicalLikeStrokes = raw.split(/\s+/).map((stroke) => stroke.trim()).filter(Boolean)
    if (canonicalLikeStrokes.length > 1) rawStrokes = canonicalLikeStrokes
  }
  if (rawStrokes.length === 0) return { ok: false, error: 'Keybinding is empty.' }
  if (rawStrokes.length > 2) return { ok: false, error: 'Only one or two-stroke chords are supported.' }

  const strokes: KeybindingStroke[] = []
  for (const rawStroke of rawStrokes) {
    const tokens = splitStroke(rawStroke)
    if (tokens.length === 0) return { ok: false, error: 'Stroke is empty.' }

    const modifiers = new Set<KeybindingModifier>()
    let key: string | null = null
    for (const token of tokens) {
      const compact = token.toLowerCase().replace(/\s+/g, '')
      const modifier = MODIFIER_ALIASES[compact]
      if (modifier) {
        modifiers.add(modifier)
        continue
      }
      if (key !== null) return { ok: false, error: `Stroke "${rawStroke}" has more than one key.` }
      key = normalizeKeyToken(token)
    }

    if (key === null) return { ok: false, error: `Stroke "${rawStroke}" is missing a key.` }
    if (MODIFIER_ALIASES[key]) return { ok: false, error: `Stroke "${rawStroke}" is missing a key.` }
    if (key.length !== 1 && !/^(?:f(?:[1-9]|1[0-9]|2[0-4])|arrow(?:left|right|up|down)|backspace|delete|enter|escape|home|end|pageup|pagedown|space|tab)$/.test(key)) {
      return { ok: false, error: `Unsupported key "${key}".` }
    }

    const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
    strokes.push({ modifiers: orderedModifiers, key })
  }

  const canonical = strokes.map((stroke) => [...stroke.modifiers, stroke.key].join('+')).join(' ')
  return { ok: true, chord: { strokes, canonical } }
}

export function normalizeKeybinding(input: string): string | null {
  const parsed = parseKeybinding(input)
  return parsed.ok ? parsed.chord.canonical : null
}

export function collapseDuplicateKeybindings(keybindings: readonly string[]): string[] {
  const seen = new Set<string>()
  const collapsed: string[] = []
  for (const keybinding of keybindings) {
    const canonical = normalizeKeybinding(keybinding)
    if (!canonical || seen.has(canonical)) continue
    seen.add(canonical)
    collapsed.push(canonical)
  }
  return collapsed
}

function renderStrokeKeys(stroke: KeybindingStroke, platform: KeybindingPlatform): string[] {
  return [
    ...stroke.modifiers.map((modifier) => {
      if (modifier === 'primary') return platform === 'darwin' ? 'Cmd' : 'Ctrl'
      if (modifier === 'alt' && platform === 'darwin') return 'Option'
      return DISPLAY_MODIFIER[modifier]
    }),
    DISPLAY_KEY[stroke.key] ?? stroke.key.toUpperCase(),
  ]
}

export function renderKeybinding(input: string | KeybindingChord, platform: KeybindingPlatform = 'linux'): string {
  const chord = typeof input === 'string' ? parseKeybinding(input) : { ok: true as const, chord: input }
  if (!chord.ok) return input as string
  return chord.chord.strokes
    .map((stroke) => renderStrokeKeys(stroke, platform).join('+'))
    .join(' then ')
}

export function keybindingToKbdKeys(input: string | KeybindingChord, platform: KeybindingPlatform = 'linux'): string[][] {
  const chord = typeof input === 'string' ? parseKeybinding(input) : { ok: true as const, chord: input }
  if (!chord.ok) return []
  return chord.chord.strokes.map((stroke) => renderStrokeKeys(stroke, platform))
}

// Persisted keybinding overrides / disabled flags are keyed by command id.
// When a command's id migrates (e.g. Watchtower's commands re-namespaced
// under the switchboard module by MC-1533), the user's persisted settings
// keep working through this map. Keys are the CURRENT ids, values the legacy
// ids they replaced; every read of persisted keybinding state consults it.
export const LEGACY_COMMAND_ID_ALIASES: Record<string, string> = {
  'switchboard.watchtower.run.review': 'watchtower.run.review',
  'switchboard.watchtower.triage.inbox': 'watchtower.triage.inbox',
  'switchboard.watchtower.open.active-review': 'watchtower.open.active-review',
  'switchboard.watchtower.import.github': 'watchtower.import.github',
  'switchboard.watchtower.import.jira': 'watchtower.import.jira',
  'switchboard.watchtower.refresh.board': 'watchtower.refresh.board',
}
