import { isCommandAvailable, type CommandAvailabilityContext } from './availability'
import { COMMAND_REGISTRY } from './commandRegistry'
import { isModifierKeyToken, LEGACY_COMMAND_ID_ALIASES, parseKeybinding, type KeybindingPlatform, type KeybindingStroke } from './keybindings'
import type { CommandContribution, CommandScope, ModuleCommandContext } from './types'

export type CommandDispatcherKeyEvent = {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target?: EventTarget | null
  defaultPrevented?: boolean
  // A held key's auto-repeat (Windows and Linux repeat modifiers too). A repeat
  // is not a fresh press, so it can neither start nor restart a modifier tap.
  repeat?: boolean
  // Set while an IME composition is in flight. Composed keydowns arrive as
  // `Process` and match nothing, so the keydown path is composition-safe by
  // construction; the modifier keys keep their own names throughout, so the
  // keyup path has to check.
  isComposing?: boolean
}

export type CommandDispatcherContext = {
  activeScopes: readonly CommandScope[]
  // The full command universe to match against: the static shell registry plus
  // enabled module commands (RendererKernel.getCommandContributions). Defaults
  // to the shell registry alone, so callers without a module host keep the
  // previous behavior. Order is priority on equal scope specificity, which is
  // what keeps a module binding from silently shadowing a built-in.
  commands?: readonly CommandContribution[]
  disabledCommandIds?: ReadonlySet<string>
  keybindingOverrides?: Readonly<Record<string, readonly string[]>>
  // Runtime preconditions (architect on roster, voice
  // dictation enabled, …). A keybinding only matches when its command's
  // declared availability is satisfied, so the dispatcher refuses commands the
  // command palette would hide instead of firing a silent no-op.
  availability?: CommandAvailabilityContext
  // The published context view module availability predicates evaluate
  // against; absent, predicate-gated module commands never match.
  moduleContext?: ModuleCommandContext
  isSuppressedTarget?: (target: EventTarget | null | undefined) => boolean
  platform: KeybindingPlatform
  now?: number
}

export type CommandDispatcherResult =
  | { kind: 'matched'; commandId: string; command: CommandContribution; preventDefault: true }
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
  command: CommandContribution
  strokes: readonly StrokeSignature[]
  specificity: number
  order: number
}

type ModifierTap = {
  key: string
  at: number
}

type PendingChord = {
  // Only the first stroke is retained; the matching chord set is re-derived from
  // the live context when the second stroke arrives, so a chord cannot complete
  // a command that has since left scope, been disabled, lost its availability,
  // or been rebound during the timeout window.
  firstStroke: StrokeSignature
  startedAt: number
}

const DEFAULT_CHORD_TIMEOUT_MS = 1_000

/**
 * How long after a lone-modifier tap a second tap still reads as a double tap.
 *
 * Deliberately much shorter than the 1s two-stroke chord window: a chord is a
 * deliberate sequence a person can pause inside, a double tap is one gesture,
 * and every millisecond of this window is a millisecond in which an ordinary
 * Shift release could be mistaken for the first half of one. 400ms is
 * comfortably above a fast double tap (~150-250ms) and short enough that an
 * ordinary Shift release is not held as the first half of the gesture.
 */
export const MODIFIER_DOUBLE_TAP_MS = 400

// Physical modifier keys as `keyFromEvent` reports them, mapped onto the
// parser's canonical tokens. `Control` is the DOM's name for what keybindings
// call `ctrl`; `OS` is the legacy name older Chromium gave the Meta key.
const MODIFIER_KEY_BY_EVENT_KEY: Record<string, string> = {
  shift: 'shift',
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  altgraph: 'alt',
  meta: 'meta',
  os: 'meta',
}

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
  const lowered = event.key.toLowerCase()
  // A modifier pressed on its own is a key in its own right (`Shift Shift`),
  // so it resolves to the same token the parser produces for it.
  return MODIFIER_KEY_BY_EVENT_KEY[lowered] ?? lowered
}

function eventSignature(event: CommandDispatcherKeyEvent, platform: KeybindingPlatform): StrokeSignature {
  const key = keyFromEvent(event)
  // A lone modifier press stamps its own flag (a Shift keydown carries
  // shiftKey: true), which would otherwise make it un-matchable against the
  // modifier-less stroke `{ modifiers: [], key: 'shift' }`. When the modifier
  // IS the key it is not a modifier ON itself, so its flag is zeroed — and
  // with it `primary`, which that same modifier may have raised.
  const selfModifier = isModifierKeyToken(key) ? key : null
  const ctrl = event.ctrlKey === true && selfModifier !== 'ctrl'
  const meta = event.metaKey === true && selfModifier !== 'meta'
  return {
    key,
    primary: platform === 'darwin' ? meta : ctrl,
    ctrl,
    meta,
    alt: event.altKey === true && selfModifier !== 'alt',
    shift: event.shiftKey === true && selfModifier !== 'shift',
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

function scopeSpecificity(command: CommandContribution, activeScopes: readonly CommandScope[]): number {
  if (command.scopes.some((scope) => scope.startsWith('panel:') && activeScopes.includes(scope))) return 4
  if (command.scopes.includes('editor') && activeScopes.includes('editor')) return 3
  if (command.scopes.includes('terminal') && activeScopes.includes('terminal')) return 3
  if (command.scopes.includes('workspace') && activeScopes.includes('workspace')) return 2
  if (command.scopes.includes('workspace-navigation') && activeScopes.includes('workspace-navigation')) return 2
  if (command.scopes.includes('global')) return 1
  return 0
}

function commandIsActive(command: CommandContribution, activeScopes: readonly CommandScope[]): boolean {
  return scopeSpecificity(command, activeScopes) > 0
}

function effectiveKeybindings(command: CommandContribution, overrides?: Readonly<Record<string, readonly string[]>>): readonly string[] {
  const legacyId = LEGACY_COMMAND_ID_ALIASES[command.id]
  const override = overrides?.[command.id] ?? (legacyId ? overrides?.[legacyId] : undefined)
  return override && override.length > 0 ? override : command.defaultKeybindings ?? []
}

function activeBindings(context: CommandDispatcherContext): ActiveBinding[] {
  const bindings: ActiveBinding[] = []
  const commands = context.commands ?? COMMAND_REGISTRY
  commands.forEach((command, order) => {
    if (context.disabledCommandIds?.has(command.id)) return
    if (!commandIsActive(command, context.activeScopes)) return
    if (!isCommandAvailable(command, context.availability ?? {}, context.moduleContext)) return
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

function isLoneModifierStroke(signature: StrokeSignature): boolean {
  return isModifierKeyToken(signature.key)
    && !signature.primary && !signature.ctrl && !signature.meta && !signature.alt && !signature.shift
}

function isModifierTapBinding(binding: ActiveBinding, key: string): boolean {
  return binding.strokes.length === 2
    && binding.strokes.every((stroke) => stroke.key === key && isLoneModifierStroke(stroke))
}

export class RendererCommandDispatcher {
  private pending: PendingChord | null = null
  // The lone modifier currently held with nothing pressed since — a tap in
  // progress. Any other keydown clears it, which is what keeps Shift+A (and a
  // held, auto-repeating Shift) from ever completing the gesture.
  private modifierDown: string | null = null
  // The last completed lone-modifier tap, waiting for its twin.
  private modifierTap: ModifierTap | null = null

  constructor(
    private readonly chordTimeoutMs = DEFAULT_CHORD_TIMEOUT_MS,
    private readonly modifierTapWindowMs = MODIFIER_DOUBLE_TAP_MS,
  ) {}

  reset(): void {
    this.pending = null
    this.modifierDown = null
    this.modifierTap = null
  }

  /**
   * The release half of a lone-modifier double tap (`Shift Shift`).
   *
   * A tap is only a tap once the key comes back UP with nothing pressed in
   * between, so the gesture is decided here rather than on keydown: a Shift
   * held down — or auto-repeating on Windows and Linux — produces no second
   * release and can never trigger itself, and a Shift held to type a capital
   * is disqualified by the letter's keydown before the release arrives.
   *
   * Target suppression does not apply. `⌘K` is withheld from a terminal or an
   * editor because it may be that surface's own key; a lone Shift tap is not
   * text, is not a shell binding, and is exactly the gesture a person makes
   * while their hands are in a terminal — which is the whole point of it.
   */
  resolveKeyUp(event: CommandDispatcherKeyEvent, context: CommandDispatcherContext): CommandDispatcherResult {
    const signature = eventSignature(event, context.platform)
    if (!isModifierKeyToken(signature.key)) return { kind: 'unmatched', preventDefault: false }
    // A Shift released mid-composition is part of the IME's own conversation
    // (Japanese and Chinese IMEs use it to switch modes), never a tap of ours.
    const clean = event.isComposing !== true && this.modifierDown === signature.key && isLoneModifierStroke(signature)
    this.modifierDown = null
    if (!clean) {
      this.modifierTap = null
      return { kind: 'unmatched', preventDefault: false }
    }

    const now = context.now ?? Date.now()
    const previous = this.modifierTap
    this.modifierTap = null
    if (!previous || previous.key !== signature.key || now - previous.at > this.modifierTapWindowMs) {
      this.modifierTap = { key: signature.key, at: now }
      return { kind: 'unmatched', preventDefault: false }
    }

    const match = activeBindings(context).find((binding) => isModifierTapBinding(binding, signature.key))
    if (!match) return { kind: 'unmatched', preventDefault: false }
    return { kind: 'matched', commandId: match.command.id, command: match.command, preventDefault: true }
  }

  resolve(event: CommandDispatcherKeyEvent, context: CommandDispatcherContext): CommandDispatcherResult {
    if (event.defaultPrevented) return { kind: 'unmatched', preventDefault: false }
    const now = context.now ?? Date.now()
    const targetSuppressed = context.isSuppressedTarget?.(event.target) === true
    const eventStroke = eventSignature(event, context.platform)

    // A modifier pressed on its own is never a stroke by itself: it arms the
    // double-tap gesture and otherwise falls straight through. Returning here
    // is what keeps the first half of `Shift Shift` from being swallowed as a
    // pending chord — swallow it and capitals stop working.
    if (isModifierKeyToken(eventStroke.key)) {
      if (isLoneModifierStroke(eventStroke)) {
        // Only a fresh press arms. Auto-repeats of a held Shift leave whatever
        // state the presses between them produced: a letter typed under a held
        // Shift disarmed it, and no repeat may arm it again before the release.
        if (event.repeat !== true) this.modifierDown = eventStroke.key
      } else {
        this.modifierDown = null
        this.modifierTap = null
      }
      return { kind: 'unmatched', preventDefault: false }
    }
    // Any other key ends a tap gesture in progress, so neither `Shift+A` nor a
    // Shift tap followed by ordinary typing can complete the double tap.
    this.modifierDown = null
    this.modifierTap = null

    if (this.pending && now - this.pending.startedAt <= this.chordTimeoutMs) {
      const firstStroke = this.pending.firstStroke
      this.pending = null
      // Revalidate against the current context: the chord completes only if a
      // command is still active, enabled, available, and bound to this exact
      // two-stroke sequence right now — not merely when the chord started.
      const match = activeBindings(context)
        .filter((binding) => !targetSuppressed || binding.command.allowInEditableTarget === true)
        .filter((binding) => binding.strokes.length > 1)
        .filter((binding) => signaturesMatch(binding.strokes[0], firstStroke))
        .find((binding) => signaturesMatch(binding.strokes[1], eventStroke))
      if (match) {
        return { kind: 'matched', commandId: match.command.id, command: match.command, preventDefault: true }
      }
    } else {
      this.pending = null
    }

    const candidates = activeBindings(context)
      .filter((binding) => !targetSuppressed || binding.command.allowInEditableTarget === true)
      .filter((binding) => signaturesMatch(binding.strokes[0], eventStroke))

    const chordCandidates = candidates.filter((binding) => binding.strokes.length > 1)
    if (chordCandidates.length > 0) {
      this.pending = { firstStroke: eventStroke, startedAt: now }
      return { kind: 'pending', preventDefault: true }
    }

    const match = candidates.find((binding) => binding.strokes.length === 1)
    if (!match) return { kind: 'unmatched', preventDefault: false }
    this.pending = null
    return { kind: 'matched', commandId: match.command.id, command: match.command, preventDefault: true }
  }
}
