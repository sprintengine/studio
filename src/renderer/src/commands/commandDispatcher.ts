import { COMMAND_REGISTRY, type CommandId } from './commandRegistry'
import { parseKeybinding, type KeybindingPlatform, type KeybindingStroke } from './keybindings'
import type { CommandDefinition, CommandScope } from './types'

export type CommandDispatcherKeyEvent = {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target?: EventTarget | null
  defaultPrevented?: boolean
}

export type CommandDispatcherContext = {
  activeScopes: readonly CommandScope[]
  disabledCommandIds?: ReadonlySet<string>
  keybindingOverrides?: Readonly<Record<string, readonly string[]>>
  isSuppressedTarget?: (target: EventTarget | null | undefined) => boolean
  platform: KeybindingPlatform
  now?: number
}

export type CommandDispatcherResult =
  | { kind: 'matched'; commandId: CommandId; command: CommandDefinition; preventDefault: true }
  | { kind: 'pending'; preventDefault: true }
  | { kind: 'unmatched'; preventDefault: false }

type StrokeSignature = {
  key: string
  primary: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

type ActiveBinding = {
  command: CommandDefinition
  strokes: readonly StrokeSignature[]
  specificity: number
  order: number
}

type PendingChord = {
  bindings: readonly ActiveBinding[]
  startedAt: number
}

const DEFAULT_CHORD_TIMEOUT_MS = 1_000

const KEY_BY_CODE: Record<string, string> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
  Space: 'space',
  Tab: 'tab',
  Enter: 'enter',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright',
  ArrowUp: 'arrowup',
  ArrowDown: 'arrowdown',
}

/**
 * Normalize a keydown to the dispatcher's canonical key token, derived from the
 * physical `code` (so shifted punctuation like `?` resolves to its unshifted
 * key `/`). Exported so the Shortcuts recorder records the same key identity the
 * dispatcher matches on — otherwise a recorded `Shift+/` would never fire.
 */
export function keyFromEvent(event: CommandDispatcherKeyEvent): string {
  const code = event.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase()
  if (KEY_BY_CODE[code]) return KEY_BY_CODE[code]
  if (event.key === ' ') return 'space'
  return event.key.toLowerCase()
}

function eventSignature(event: CommandDispatcherKeyEvent, platform: KeybindingPlatform): StrokeSignature {
  const primary = platform === 'darwin' ? event.metaKey === true : event.ctrlKey === true
  return {
    key: keyFromEvent(event),
    primary,
    ctrl: event.ctrlKey === true,
    meta: event.metaKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
  }
}

function strokeSignature(stroke: KeybindingStroke, platform: KeybindingPlatform): StrokeSignature {
  let primary = false
  let ctrl = false
  let meta = false
  for (const modifier of stroke.modifiers) {
    if (modifier === 'primary') primary = true
    if (modifier === 'ctrl') {
      ctrl = true
      if (platform !== 'darwin') primary = true
    }
    if (modifier === 'meta') {
      meta = true
      if (platform === 'darwin') primary = true
    }
  }
  return {
    key: stroke.key,
    primary,
    ctrl: ctrl || (primary && platform !== 'darwin'),
    meta: meta || (primary && platform === 'darwin'),
    alt: stroke.modifiers.includes('alt'),
    shift: stroke.modifiers.includes('shift'),
  }
}

function signaturesMatch(a: StrokeSignature, b: StrokeSignature): boolean {
  return a.key === b.key
    && a.primary === b.primary
    && a.ctrl === b.ctrl
    && a.meta === b.meta
    && a.alt === b.alt
    && a.shift === b.shift
}

function scopeSpecificity(command: CommandDefinition, activeScopes: readonly CommandScope[]): number {
  if (command.scopes.some((scope) => scope.startsWith('panel:') && activeScopes.includes(scope))) return 4
  if (command.scopes.includes('editor') && activeScopes.includes('editor')) return 3
  if (command.scopes.includes('terminal') && activeScopes.includes('terminal')) return 3
  if (command.scopes.includes('workspace') && activeScopes.includes('workspace')) return 2
  if (command.scopes.includes('workspace-navigation') && activeScopes.includes('workspace-navigation')) return 2
  if (command.scopes.includes('global')) return 1
  return 0
}

function commandIsActive(command: CommandDefinition, activeScopes: readonly CommandScope[]): boolean {
  return scopeSpecificity(command, activeScopes) > 0
}

function effectiveKeybindings(command: CommandDefinition, overrides?: Readonly<Record<string, readonly string[]>>): readonly string[] {
  const override = overrides?.[command.id]
  return override && override.length > 0 ? override : command.defaultKeybindings ?? []
}

function activeBindings(context: CommandDispatcherContext): ActiveBinding[] {
  const bindings: ActiveBinding[] = []
  COMMAND_REGISTRY.forEach((command, order) => {
    if (context.disabledCommandIds?.has(command.id)) return
    if (!commandIsActive(command, context.activeScopes)) return
    for (const keybinding of effectiveKeybindings(command, context.keybindingOverrides)) {
      const parsed = parseKeybinding(keybinding)
      if (!parsed.ok) continue
      bindings.push({
        command,
        strokes: parsed.chord.strokes.map((stroke) => strokeSignature(stroke, context.platform)),
        specificity: scopeSpecificity(command, context.activeScopes),
        order,
      })
    }
  })
  return bindings.sort((a, b) => b.specificity - a.specificity || a.order - b.order)
}

export class RendererCommandDispatcher {
  private pending: PendingChord | null = null

  constructor(private readonly chordTimeoutMs = DEFAULT_CHORD_TIMEOUT_MS) {}

  reset(): void {
    this.pending = null
  }

  resolve(event: CommandDispatcherKeyEvent, context: CommandDispatcherContext): CommandDispatcherResult {
    if (event.defaultPrevented) return { kind: 'unmatched', preventDefault: false }
    const now = context.now ?? Date.now()
    const targetSuppressed = context.isSuppressedTarget?.(event.target) === true
    const eventStroke = eventSignature(event, context.platform)

    if (this.pending && now - this.pending.startedAt <= this.chordTimeoutMs) {
      const match = this.pending.bindings.find((binding) => signaturesMatch(binding.strokes[1], eventStroke))
      this.pending = null
      if (match && (!targetSuppressed || match.command.allowInEditableTarget === true)) {
        return { kind: 'matched', commandId: match.command.id as CommandId, command: match.command, preventDefault: true }
      }
    } else {
      this.pending = null
    }

    const candidates = activeBindings(context)
      .filter((binding) => !targetSuppressed || binding.command.allowInEditableTarget === true)
      .filter((binding) => signaturesMatch(binding.strokes[0], eventStroke))

    const chordCandidates = candidates.filter((binding) => binding.strokes.length > 1)
    if (chordCandidates.length > 0) {
      this.pending = { bindings: chordCandidates, startedAt: now }
      return { kind: 'pending', preventDefault: true }
    }

    const match = candidates.find((binding) => binding.strokes.length === 1)
    if (!match) return { kind: 'unmatched', preventDefault: false }
    this.pending = null
    return { kind: 'matched', commandId: match.command.id as CommandId, command: match.command, preventDefault: true }
  }
}
