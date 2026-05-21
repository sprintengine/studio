import type { ITheme, Terminal } from '@xterm/xterm'

// xterm.js does not read CSS variables, so we resolve the theme-relevant
// tokens off `:root` at terminal-mount time and re-resolve whenever the
// `<html data-theme>` attribute changes. Each Terminal instance subscribes
// individually; the MutationObserver shared singleton broadcasts to every
// subscriber so all live terminals re-tint in lockstep.

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value || fallback
}

export function getTerminalTheme(): ITheme {
  // Terminals read from dedicated --terminal-* tokens so they can sit deeper
  // than the panel chrome (e.g. inverted "dark screen" on Light theme). Fall
  // back to the surface scale tokens for any theme that hasn't declared
  // terminal-specific values, which preserves backwards compatibility.
  return {
    background: readVar('--terminal-bg', readVar('--bg-app', '#08090b')),
    foreground: readVar('--terminal-fg', readVar('--text-strong', '#ececee')),
    cursor: readVar('--terminal-cursor', readVar('--accent-primary', '#5c7cff')),
  }
}

type Subscriber = () => void
const subscribers = new Set<Subscriber>()
let observer: MutationObserver | null = null

function ensureObserver(): void {
  if (observer || typeof window === 'undefined') return
  observer = new MutationObserver((mutations) => {
    if (!mutations.some((m) => m.attributeName === 'data-theme')) return
    for (const fn of subscribers) {
      try {
        fn()
      } catch {
        // Subscriber threw; keep notifying the rest.
      }
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

// Apply the current theme to `term`, then subscribe so the terminal re-tints
// on every `<html data-theme>` change. Returns a dispose function that
// removes the subscription. Call dispose alongside the existing terminal
// teardown.
export function bindTerminalTheme(term: Terminal): () => void {
  term.options.theme = getTerminalTheme()
  ensureObserver()
  const onChange: Subscriber = () => {
    term.options.theme = getTerminalTheme()
  }
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
  }
}
