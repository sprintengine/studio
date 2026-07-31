// The splash's close contract, kept separate from Electron so it can be tested
// as what it is: a one-shot race between two triggers.
//
// The main window is revealed on whichever comes first —
//   1. `app:boot-complete` from the primary renderer, or
//   2. a hard timeout.
//
// `ready-to-show` alone is NOT enough for (1): it fires before hydration and
// boot discovery settle, which is the exact window the splash exists to cover.
//
// (2) is not optional. The splash is always-on-top and the main window is hidden
// until revealed, so a renderer that crashes or never reaches its first frame
// would otherwise leave a stuck plate over a permanently invisible app, with no
// way out but Force Quit.
export const BOOT_REVEAL_TIMEOUT_MS = 10_000

export type BootRevealTimers = {
  setTimer: (handler: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export type BootRevealOptions = {
  // Runs exactly once. Closes the splash and shows the main window.
  reveal: () => void
  timeoutMs?: number
  timers?: BootRevealTimers
}

export type BootReveal = {
  // Called when the renderer reports its first frame. Safe to call late, twice,
  // or after the timeout already fired.
  trigger: () => void
  // True once `reveal` has run, by either path.
  get revealed(): boolean
}

const defaultTimers: BootRevealTimers = {
  setTimer: (handler, ms) => setTimeout(handler, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createBootReveal({
  reveal,
  timeoutMs = BOOT_REVEAL_TIMEOUT_MS,
  timers = defaultTimers,
}: BootRevealOptions): BootReveal {
  let revealed = false
  let timeoutHandle: unknown = null

  const run = (): void => {
    if (revealed) return
    revealed = true
    if (timeoutHandle !== null) {
      timers.clearTimer(timeoutHandle)
      timeoutHandle = null
    }
    reveal()
  }

  timeoutHandle = timers.setTimer(run, timeoutMs)

  return {
    trigger: run,
    get revealed() {
      return revealed
    },
  }
}
