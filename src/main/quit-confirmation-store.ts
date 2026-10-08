/**
 * The "Ask before quitting while agents are working" switch, owned by main.
 *
 * Unlike the background-mode mirror, main writes this one itself: "Don't ask
 * again" is ticked in a native dialog, at a moment the renderer may be busy or
 * have no window at all. So main keeps the value, Settings reads and writes it
 * over IPC, and there is one writer per change rather than two copies to
 * reconcile.
 *
 * Absent, unreadable or malformed all read as ON: the question is the safe
 * default, and a store we cannot trust should cost the person one extra
 * question, never a quit that stopped their agents without one.
 */
import { createBooleanFileSetting, type BooleanFileSetting, type BooleanFileSettingDeps } from './boolean-file-setting'

export type QuitConfirmationStore = BooleanFileSetting

/** `isEnabled()` is whether a quit asks while agents are working. */
export function createQuitConfirmationStore(deps: BooleanFileSettingDeps): QuitConfirmationStore {
  return createBooleanFileSetting(
    {
      fileName: 'quit-confirmation.json',
      key: 'askBeforeQuit',
      fallback: true,
      notPersisted: {
        title: 'Quit confirmation setting not persisted',
        message:
          'The "Ask before quitting" setting could not be written to disk; it applies for this session but will not survive a restart.',
      },
    },
    deps,
  )
}
