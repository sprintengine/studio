/**
 * What the machine and the person are doing, as the main process's timers need
 * to know it: whether any app window has focus, whether the machine is asleep,
 * and whether it is running on battery.
 *
 * The app exists partly to keep a laptop's battery alive while agents work, so
 * the background loops main runs on its own clock have to know when nobody is
 * looking and when every wakeup costs charge. This module is the one place those
 * three facts live. It imports nothing from Electron: `app-lifecycle.ts` feeds it
 * from `powerMonitor` and the window focus events once the app is ready, and
 * every consumer — the stall heartbeat, the network poller, the automations
 * scheduler — subscribes here, so each of them is testable with a plain object
 * standing in for the machine.
 */

export type PowerActivity = {
  /** True while at least one app window has keyboard focus. */
  isFocused(): boolean
  /** True between `suspend` and `resume`. */
  isSuspended(): boolean
  isOnBattery(): boolean
  /** True between `lock-screen` and `unlock-screen`. */
  isScreenLocked(): boolean
  onScreenLockChange(listener: (locked: boolean) => void): () => void
  noteScreenLocked(locked: boolean): void
  onFocusChange(listener: (focused: boolean) => void): () => void
  onSuspend(listener: () => void): () => void
  onResume(listener: () => void): () => void
  onBatteryChange(listener: (onBattery: boolean) => void): () => void
  noteFocus(focused: boolean): void
  noteSuspend(): void
  noteResume(): void
  noteBattery(onBattery: boolean): void
}

export function createPowerActivity(initial: { focused?: boolean; onBattery?: boolean } = {}): PowerActivity {
  let focused = initial.focused ?? false
  let suspended = false
  let onBattery = initial.onBattery ?? false
  let screenLocked = false
  const lockListeners = new Set<(locked: boolean) => void>()
  const focusListeners = new Set<(focused: boolean) => void>()
  const suspendListeners = new Set<() => void>()
  const resumeListeners = new Set<() => void>()
  const batteryListeners = new Set<(onBattery: boolean) => void>()

  const emit = <T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T): void => {
    for (const listener of [...listeners]) {
      try {
        listener(...args)
      } catch (error) {
        console.warn('[power-activity] listener failed', error)
      }
    }
  }
  const subscribe = <L>(listeners: Set<L>, listener: L): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    isFocused: () => focused,
    isSuspended: () => suspended,
    isOnBattery: () => onBattery,
    isScreenLocked: () => screenLocked,
    onScreenLockChange: (listener) => subscribe(lockListeners, listener),
    noteScreenLocked(next) {
      if (next === screenLocked) return
      screenLocked = next
      emit(lockListeners, next)
    },
    onFocusChange: (listener) => subscribe(focusListeners, listener),
    onSuspend: (listener) => subscribe(suspendListeners, listener),
    onResume: (listener) => subscribe(resumeListeners, listener),
    onBatteryChange: (listener) => subscribe(batteryListeners, listener),
    noteFocus(next) {
      if (next === focused) return
      focused = next
      emit(focusListeners, next)
    },
    noteSuspend() {
      if (suspended) return
      suspended = true
      emit(suspendListeners)
    },
    // Not edge-guarded: a wake whose `suspend` was never delivered (Windows
    // can skip it on a lid close) is still a wake, and every consumer's resume
    // handling is idempotent.
    noteResume() {
      suspended = false
      emit(resumeListeners)
    },
    noteBattery(next) {
      if (next === onBattery) return
      onBattery = next
      emit(batteryListeners, next)
    },
  }
}

/** The process-wide instance `app-lifecycle.ts` feeds and the services read. */
export const powerActivity = createPowerActivity()

type StallHeartbeat = {
  start(): void
  stop(): void
  reset(): void
}

/**
 * Run the main-thread stall heartbeat only while a window has focus and the
 * machine is awake.
 *
 * The heartbeat exists to catch the freeze a person feels as a dead terminal,
 * and nobody feels one in a window they are not using. Off-focus it cost 120
 * wakeups a minute for nothing. A wake from sleep resets its baseline so the
 * nap is not written down as a stall.
 */
export function gateStallMonitorOnActivity(activity: PowerActivity, monitor: StallHeartbeat): () => void {
  const sync = (): void => {
    if (activity.isFocused() && !activity.isSuspended()) monitor.start()
    else monitor.stop()
  }
  const disposers = [
    activity.onFocusChange(sync),
    activity.onSuspend(() => monitor.stop()),
    activity.onResume(() => {
      monitor.reset()
      sync()
    }),
  ]
  sync()
  return () => {
    for (const dispose of disposers) dispose()
    monitor.stop()
  }
}

type ActivityAwarePoller = {
  suspend(): void
  wake(): void
  noteFocus(): void
  setOnBattery(onBattery: boolean): void
}

/**
 * Hand the network poller the machine's state: nothing on a sleeping machine,
 * a check on waking and on coming back to the app after a while, and longer
 * gaps while on battery. The poller owns the arithmetic; this only routes.
 */
export function bindPollerToActivity(activity: PowerActivity, poller: ActivityAwarePoller): () => void {
  poller.setOnBattery(activity.isOnBattery())
  const disposers = [
    activity.onSuspend(() => poller.suspend()),
    activity.onResume(() => poller.wake()),
    activity.onBatteryChange((onBattery) => poller.setOnBattery(onBattery)),
    activity.onFocusChange((focused) => {
      if (focused) poller.noteFocus()
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
