// The renderer's half of the static New chat box (public/boot-composer.js):
// capturing the panel the box is drawn from, and taking the box over when the
// real composer arrives.
//
// The capture is written only from the New chat panel in its untouched state —
// no words, no images, no project, no skill or connector picks — in a window
// with no chats, which is exactly the panel the next launch of that window
// opens on. So it holds what any first frame of New chat would show and
// nothing a person typed or chose for one chat: no draft, no chat title, no
// project path. It is dropped as soon as the window has a chat, since then the
// window no longer opens on New chat.

/** What the box held when the real composer took it over. */
export type BootComposerInput = {
  text: string
  selectionStart: number
  selectionEnd: number
  focused: boolean
  /** Enter was pressed in the box; the chat it asked for has not started yet. */
  enterPending: boolean
}

type LiveBox = { host: HTMLElement; input: HTMLTextAreaElement; enterPending: boolean }

type BootComposerBridge = {
  version: number
  storageKey: string
  lookSignature(): string
  buildId(): string
  windowId: string | null
  live: LiveBox | null
  seed: number | null
}

type BootComposerSnapshot = {
  version: number
  build: string
  signature: string
  windowId: string
  insets: { top: number; right: number; bottom: number; left: number }
  /** The corner radius of the card that clips the panel, so the box is clipped the same. */
  radius: string
  html: string
  seed: number
}

function bridge(): BootComposerBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as { sprintengineBootComposer?: BootComposerBridge }).sprintengineBootComposer
  return candidate && typeof candidate.lookSignature === 'function' ? candidate : null
}

/** Whether the box is on screen and nothing has taken it yet. */
export function bootComposerLive(): boolean {
  const live = bridge()?.live
  return Boolean(live && live.host.isConnected)
}

/** The suggestion draw the box was captured with, so the panel replacing it draws the same cards. */
export function bootComposerSeed(): number | null {
  return bootComposerLive() ? (bridge()?.seed ?? null) : null
}

/** Where the box's composer stands on screen, for checking the real one lands on it. */
export function bootComposerRect(): DOMRect | null {
  const live = bridge()?.live
  return live?.host.isConnected
    ? (live.host.querySelector('[data-new-chat-composer]')?.getBoundingClientRect() ?? null)
    : null
}

function removeBox(live: LiveBox): void {
  live.host.remove()
  const owner = bridge()
  if (owner?.live === live) owner.live = null
}

/**
 * Takes the box over: returns what it held and removes it. Called from the
 * real composer's mount, inside the same commit that draws it, so the box and
 * the composer are never both on screen and never both missing.
 */
export function claimBootComposer(): BootComposerInput | null {
  const live = bridge()?.live
  if (!live || !live.host.isConnected) return null
  const { input } = live
  const taken: BootComposerInput = {
    text: input.value,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    focused: document.activeElement === input,
    enterPending: live.enterPending,
  }
  removeBox(live)
  return taken
}

/**
 * Removes the box without a composer to hand it to — the window did not open
 * on New chat after all — and returns what was typed in it, for the caller to
 * keep.
 */
export function releaseBootComposer(): string {
  const live = bridge()?.live
  if (!live) return ''
  const text = live.input.value
  removeBox(live)
  return text
}

/** Forgets this window's capture. */
export function dropBootComposerSnapshot(): void {
  const owner = bridge()
  if (!owner) return
  try {
    const raw = window.localStorage.getItem(owner.storageKey)
    if (!raw) return
    const stored = JSON.parse(raw) as Partial<BootComposerSnapshot> | null
    if (stored && stored.windowId !== owner.windowId) return
    window.localStorage.removeItem(owner.storageKey)
  } catch {
    // Storage is best effort; a capture that cannot be read is never shown.
  }
}

// The markup of the panel, made inert: the editor becomes a plain field, every
// control is a picture of itself, and nothing that would collide with the
// live panel's ids or speak to assistive technology twice is kept.
function inertCopyOf(panel: HTMLElement, field: HTMLElement): string | null {
  const copy = panel.cloneNode(true) as HTMLElement
  const fieldCopy = copy.querySelector<HTMLElement>('[data-composer-field]')
  if (!fieldCopy) return null
  const editable = field.querySelector<HTMLElement>('.cm-content')
  const input = document.createElement('textarea')
  input.setAttribute('data-static-composer-input', '')
  // The composer box draws its focus ring off `.cm-content:focus`; the field
  // carries the class so the ring is there from the first frame, as it will be.
  input.className = 'cm-content'
  input.setAttribute('rows', '1')
  input.setAttribute('spellcheck', 'true')
  const label = editable?.getAttribute('aria-label')
  if (label) input.setAttribute('aria-label', label)
  const placeholder = editable?.getAttribute('aria-placeholder')
  if (placeholder) input.setAttribute('placeholder', placeholder)
  fieldCopy.replaceChildren(input)

  for (const element of copy.querySelectorAll<HTMLElement>('[id]')) element.removeAttribute('id')
  for (const element of copy.querySelectorAll<HTMLElement>('[aria-live]')) element.remove()
  for (const element of copy.querySelectorAll<HTMLElement>('input')) element.remove()
  for (const element of copy.querySelectorAll<HTMLElement>('[aria-expanded="true"]')) {
    element.setAttribute('aria-expanded', 'false')
  }
  for (const element of copy.querySelectorAll<HTMLElement>('button, a, [tabindex]')) {
    element.setAttribute('inert', '')
    element.setAttribute('tabindex', '-1')
  }
  return copy.outerHTML
}

/**
 * Records `panel` — the New chat panel's full-region wrapper — as this
 * window's static box. The caller vouches that the panel is untouched and the
 * window has no chats. Returns whether a capture was written.
 */
export function captureBootComposerSnapshot(panel: HTMLElement, seed: number): boolean {
  const owner = bridge()
  if (!owner?.windowId) return false
  const build = owner.buildId()
  if (!build) return false
  // Never over the box itself: what is on screen would be captured as it.
  if (bootComposerLive()) return false
  const field = panel.querySelector<HTMLElement>('[data-composer-field]')
  // A disabled field (a plain shell takes no prompt) would invite typing that
  // could only be thrown away.
  if (!field || field.getAttribute('aria-disabled') === 'true') return false
  const rect = panel.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const html = inertCopyOf(panel, field)
  if (!html) return false
  let radius = '0px'
  for (let clip = panel.parentElement; clip && clip !== document.body; clip = clip.parentElement) {
    const style = window.getComputedStyle(clip)
    if (style.overflow !== 'visible' && style.borderRadius !== '0px' && style.borderRadius !== '') {
      radius = style.borderRadius
      break
    }
  }
  const snapshot: BootComposerSnapshot = {
    version: owner.version,
    build,
    signature: owner.lookSignature(),
    windowId: owner.windowId,
    insets: {
      top: rect.top,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      left: rect.left,
    },
    radius,
    html,
    seed,
  }
  try {
    const serialized = JSON.stringify(snapshot)
    if (window.localStorage.getItem(owner.storageKey) !== serialized) {
      window.localStorage.setItem(owner.storageKey, serialized)
    }
    return true
  } catch {
    return false
  }
}
