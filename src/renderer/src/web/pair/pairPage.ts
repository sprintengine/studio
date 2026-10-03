import './pairPage.css'

// The pairing page's one job (phase 9 spec, 6.2): spend the code a pairing
// link carries for this browser's session, then open the app. The code is in
// the fragment, so it never reached the server with the page; it is removed
// from the address bar and history before anything else, and sent once.

const status = document.getElementById('pair-status')
const help = document.getElementById('pair-help')

function say(text: string, showHelp: boolean): void {
  if (status) status.textContent = text
  if (help) help.hidden = !showHelp
}

function followSystemAppearance(): void {
  const light = window.matchMedia?.('(prefers-color-scheme: light)')
  const apply = () => document.documentElement.setAttribute('data-mode', light?.matches ? 'light' : 'dark')
  apply()
  light?.addEventListener('change', apply)
}

async function pair(): Promise<void> {
  const code = new URLSearchParams(window.location.hash.slice(1)).get('code')
  // Gone from the address and from history before the code is used.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  if (!code) {
    say('This browser is not paired with Studio yet.', true)
    return
  }
  say('Pairing this browser…', false)
  try {
    const response = await fetch('./pair/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (response.ok && body.ok) {
      say('Paired. Opening Studio…', false)
      window.location.replace('./')
      return
    }
    say(body.message ?? 'This pairing link was used or has expired.', true)
  } catch {
    say('Studio could not be reached from this browser. Check that it is still running.', true)
  }
}

followSystemAppearance()
void pair()
