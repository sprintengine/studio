import './pairPage.css'

// The pairing page (phase 9 spec, 6.2). With a link: spend the code it
// carries for this browser's session, then open the app. The code is in the
// fragment, so it never reached the server with the page; it is removed from
// the address bar and history before anything else, and sent once.
//
// Without one, the browser may ask: it names itself, is shown six digits, and
// waits while the owner types them in Studio. The secret it polls with stays
// in this tab's session storage, so a reload keeps waiting on the same
// request.

const status = document.getElementById('pair-status')
const help = document.getElementById('pair-help')
const askForm = document.getElementById('pair-ask') as HTMLFormElement | null
const askButton = document.getElementById('pair-ask-button') as HTMLButtonElement | null
const nameField = document.getElementById('pair-name') as HTMLInputElement | null
const codeSection = document.getElementById('pair-code')
const digits = document.getElementById('pair-digits')
const WAITING_KEY = 'sprintengine-pair-request'
const POLL_MS = 2_000

function say(text: string, showHelp: boolean): void {
  if (status) status.textContent = text
  if (help) help.hidden = !showHelp
  if (askForm) askForm.hidden = !showHelp
}

type Waiting = { requestId: string; collect: string; code: string }

async function post(path: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  })
  return { ok: response.ok, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

function wait(waiting: Waiting): void {
  try {
    window.sessionStorage.setItem(WAITING_KEY, JSON.stringify(waiting))
  } catch {
    // A reload then asks again.
  }
  say('Waiting for Studio to let this browser in…', false)
  if (codeSection) codeSection.hidden = false
  if (digits) digits.textContent = `${waiting.code.slice(0, 3)} ${waiting.code.slice(3)}`
  const poll = async () => {
    const answer = await post('./pair/request/collect', {
      requestId: waiting.requestId,
      collect: waiting.collect,
    }).catch(() => null)
    const state = answer?.body.status
    if (state === 'pending' || answer === null) {
      setTimeout(() => void poll(), POLL_MS)
      return
    }
    try {
      window.sessionStorage.removeItem(WAITING_KEY)
    } catch {
      // Nothing kept.
    }
    if (codeSection) codeSection.hidden = true
    if (state === 'approved') {
      say('Paired. Opening Studio…', false)
      window.location.replace('./')
      return
    }
    say(
      state === 'declined'
        ? 'Studio declined this browser.'
        : typeof answer.body.message === 'string'
          ? answer.body.message
          : 'The request expired. Ask again.',
      true,
    )
  }
  void poll()
}

askForm?.addEventListener('submit', (event) => {
  event.preventDefault()
  if (askButton) askButton.disabled = true
  void post('./pair/request', { name: nameField?.value ?? '' })
    .then((answer) => {
      if (
        answer.ok &&
        typeof answer.body.requestId === 'string' &&
        typeof answer.body.collect === 'string' &&
        typeof answer.body.code === 'string'
      ) {
        wait({ requestId: answer.body.requestId, collect: answer.body.collect, code: answer.body.code })
        return
      }
      say(typeof answer.body.message === 'string' ? answer.body.message : 'Studio did not take the request.', true)
    })
    .catch(() => say('Studio could not be reached from this browser.', true))
    .finally(() => {
      if (askButton) askButton.disabled = false
    })
})

function waitingRequest(): Waiting | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(WAITING_KEY) ?? 'null') as Partial<Waiting> | null
    return value &&
      typeof value.requestId === 'string' &&
      typeof value.collect === 'string' &&
      typeof value.code === 'string'
      ? (value as Waiting)
      : null
  } catch {
    return null
  }
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
    const waiting = waitingRequest()
    if (waiting) wait(waiting)
    else say('This browser is not paired with Studio yet.', true)
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
