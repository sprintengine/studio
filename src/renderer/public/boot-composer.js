// The static New chat box: a typeable copy of the New chat panel, put on screen
// by the window's own HTML before the app bundle has been fetched, compiled or
// run. Classic and blocking, after #root and before the module script, for the
// same reason as boot-theme.js: it has to be in the first frame.
//
// A window that opens with no chats lands on New chat, and the panel takes
// several hundred milliseconds to arrive behind the bundle, the store and the
// CLI probe that gates it. This box stands where the panel will stand, takes
// the person's typing in the meantime, and hands it over when the real
// composer mounts (components/workspace/agentComposer/bootComposer.ts):
// the text, the caret, the focus, and an Enter pressed too early, which is
// held rather than dropped and replayed once the panel can start a chat.
//
// The box is not hand-written. It is the last New chat panel this window drew
// in its untouched state (no words, no images, no project, no picks), captured
// by the renderer as markup plus the panel's offsets from the window's edges.
// What the capture may hold is decided there; what this file checks before
// using it is:
//   - the build: markup from another build may name classes this CSS lacks;
//   - the window: only the window that drew it, and never an aux window;
//   - the look: the theme setting, and the window material, chat width and
//     contrast boot-theme.js just stamped, and the pixel ratio;
//   - the stylesheet: a document without its CSS in place (the dev server
//     injects it from script) would show the box unstyled.
// Any mismatch draws nothing; the renderer captures afresh after boot.
//
// A browser tab never shows it (no preload put a `window.api` here): the web
// client opens on whatever its server says, and this capture is per machine.
;(function () {
  var STORAGE_KEY = 'sprintengine-boot-composer'
  var VERSION = 1

  // The theme as the person set it, not as it resolved: under System the
  // pre-paint and the app can resolve light and dark a moment apart while the
  // OS appearance is still being read, and the markup is the same in both —
  // it paints with the theme's tokens, so it follows whichever the window has.
  // A theme the person changes is still a new look.
  function themeSetting() {
    try {
      var raw = window.localStorage.getItem('sprintengine-app-settings')
      var persisted = raw ? JSON.parse(raw) : null
      var appearance =
        persisted && persisted.state && persisted.state.appSettings && persisted.state.appSettings.appearance
      return (appearance && appearance.theme) || 'system'
    } catch {
      return 'unreadable'
    }
  }

  function lookSignature() {
    var root = document.documentElement
    return [
      themeSetting(),
      root.getAttribute('data-window-material') || 'solid',
      root.getAttribute('data-chat-width') || '',
      root.getAttribute('data-chat-contrast') || '',
      String(window.devicePixelRatio || 1),
    ].join('|')
  }

  function buildId() {
    var meta = document.querySelector('meta[name="sprintengine-build"]')
    return meta ? meta.getAttribute('content') || '' : ''
  }

  function windowIdOf(search) {
    var params = new URLSearchParams(search)
    if (params.get('view') || params.get('aux')) return null
    return params.get('windowId') || 'primary'
  }

  // The renderer writes captures through these, so the two sides can never
  // disagree about what a matching look or build is.
  var bridge = {
    version: VERSION,
    storageKey: STORAGE_KEY,
    lookSignature: lookSignature,
    buildId: buildId,
    windowId: windowIdOf(location.search),
    // Set once the box is on screen; cleared when the renderer takes it.
    live: null,
    seed: null,
    // Why this launch drew no box, for diagnostics: the first check that failed.
    skipped: null,
  }
  window.sprintengineBootComposer = bridge

  try {
    var skip = function (reason) {
      bridge.skipped = reason
    }
    if (typeof window.api === 'undefined') return skip('browser-tab')
    if (!bridge.windowId) return skip('not-a-workspace-window')
    var build = buildId()
    if (!build) return skip('unstamped-build')
    var raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return skip('no-capture')
    var snapshot = JSON.parse(raw)
    if (
      !snapshot ||
      snapshot.version !== VERSION ||
      snapshot.build !== build ||
      snapshot.windowId !== bridge.windowId ||
      snapshot.signature !== lookSignature() ||
      typeof snapshot.html !== 'string' ||
      !snapshot.insets
    ) {
      return skip('capture-does-not-match')
    }
    // The tokens the markup paints with come from the stylesheet; without it
    // the box would be a column of unstyled text.
    if (!window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim())
      return skip('no-stylesheet')

    var insets = snapshot.insets
    var host = document.createElement('div')
    host.id = 'boot-composer'
    host.setAttribute('data-static-composer', '')
    host.style.position = 'fixed'
    host.style.top = insets.top + 'px'
    host.style.right = insets.right + 'px'
    host.style.bottom = insets.bottom + 'px'
    host.style.left = insets.left + 'px'
    // The card the panel sits in rounds and clips its corners.
    if (typeof snapshot.radius === 'string') host.style.borderRadius = snapshot.radius
    host.style.overflow = 'hidden'
    // Above the app's own first frames (the empty stage it draws before New
    // chat opens), below every popover, modal and toast.
    host.style.zIndex = 'var(--sem-z-sticky)'
    host.innerHTML = snapshot.html

    var input = host.querySelector('textarea[data-static-composer-input]')
    if (!input) return skip('capture-has-no-field')
    // The field's own type and ink, with the editor's geometry: no padding, no
    // border, the 20px line it draws, wrapping where it wraps, growing with its
    // text between the host's floor and ceiling.
    var style = input.style
    style.display = 'block'
    style.width = '100%'
    style.minHeight = 'inherit'
    style.maxHeight = 'inherit'
    style.setProperty('field-sizing', 'content')
    style.margin = '0'
    style.padding = '0'
    style.border = '0'
    style.outline = 'none'
    style.resize = 'none'
    style.background = 'transparent'
    style.color = 'inherit'
    style.font = 'inherit'
    style.lineHeight = '20px'
    style.caretColor = 'currentColor'
    style.overflowX = 'hidden'
    style.overflowY = 'auto'
    style.whiteSpace = 'pre-wrap'
    style.wordBreak = 'break-word'
    style.overflowWrap = 'anywhere'

    var live = { host: host, input: input, enterPending: false }
    // Enter starts the chat in the real composer; here it is held, so the
    // person who types a line and presses Enter before the app is ready still
    // starts their chat. Shift+Enter is a newline in both. The Enter that
    // commits an input method's composition belongs to the input method.
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      live.enterPending = true
    })
    // Typing on after that Enter is the person carrying on, not the chat they
    // asked for: the held Enter no longer speaks for what the field says, as
    // the real composer drops it on the next key.
    input.addEventListener('input', function () {
      live.enterPending = false
    })
    // Every control in the copy is inert; a press anywhere on it keeps the
    // caret in the field rather than dropping focus onto nothing.
    host.addEventListener('mousedown', function (event) {
      if (event.target === input) return
      event.preventDefault()
      input.focus()
    })

    var root = document.getElementById('root')
    if (root && root.parentNode) root.parentNode.insertBefore(host, root.nextSibling)
    else document.body.appendChild(host)
    input.focus()
    bridge.live = live
    // The moment the window can take typing, for the boot measurements.
    if (window.performance && typeof performance.mark === 'function') performance.mark('static-composer-typeable')
    bridge.seed = typeof snapshot.seed === 'number' ? snapshot.seed : null
  } catch {
    // A capture that cannot be read is a window without the box, not a broken boot.
    bridge.skipped = 'unreadable-capture'
    var stray = document.getElementById('boot-composer')
    if (stray && stray.parentNode) stray.parentNode.removeChild(stray)
    bridge.live = null
  }
})()
