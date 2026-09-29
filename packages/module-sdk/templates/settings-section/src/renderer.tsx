import type { RegisterRenderer } from '@sprintengine/module-sdk'

import { greetingFrom, SettingsSection } from './SettingsSection'

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  )
}

// A Settings section's values are saved in this module's own settings
// namespace — the same keys `getModuleAppState` reads — so the rest of the
// extension reads what the person chose there without any wiring of its own.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerSettingsSection({
    id: '{{id}}',
    label: '{{displayName}}',
    description: 'How {{displayName}} greets you.',
    icon: SettingsIcon,
    Component: SettingsSection,
  })
  host.registerCommand({
    id: 'copy-greeting',
    title: '{{displayName}}: Copy greeting',
    category: '{{displayName}}',
    scopes: ['global'],
    async run() {
      await navigator.clipboard.writeText(
        greetingFrom({ name: host.getModuleAppState('name'), tone: host.getModuleAppState('tone') }),
      )
    },
  })
}
