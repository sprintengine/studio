/**
 * The "Keep the computer awake while agents work" switch, owned by main.
 *
 * Main is the only reader — the power-save blocker is taken and released in
 * main as agents start and stop, with or without a window open — so main
 * keeps the value and Settings reads and writes it over IPC, the same shape
 * as the quit question (quit-confirmation-store.ts).
 *
 * Absent, unreadable or malformed all read as ON: a turn that stalls because
 * the machine slept under it costs the person the work they left it to do,
 * while a machine kept up a little longer costs them nothing they would notice.
 */
import { createBooleanFileSetting, type BooleanFileSetting, type BooleanFileSettingDeps } from './boolean-file-setting'

export type KeepAwakeStore = BooleanFileSetting

/** `isEnabled()` is whether a working agent keeps the computer from sleeping. */
export function createKeepAwakeStore(deps: BooleanFileSettingDeps): KeepAwakeStore {
  return createBooleanFileSetting(
    {
      fileName: 'keep-awake.json',
      key: 'keepAwakeWhileAgentsWork',
      fallback: true,
      notPersisted: {
        title: 'Keep-awake setting not persisted',
        message:
          'The "Keep the computer awake while agents work" setting could not be written to disk; it applies for this session but will not survive a restart.',
      },
    },
    deps,
  )
}
