import type { RegisterRenderer } from '@sprintengine/module-sdk'

import { createFocusTimer } from './FocusTimer'

// The top bar is dense: one compact control, not a cluster. `order` places it
// among other modules' items (lower first). The component owns everything —
// state, label, what a click does; the shell only places it.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerTopBarItem({
    id: '{{id}}.timer',
    order: 100,
    Component: createFocusTimer(host),
  })
}
