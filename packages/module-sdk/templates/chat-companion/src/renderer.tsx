import type { RegisterRenderer } from '@sprintengine/module-sdk'

import { createCompanion } from './Companion'

function CompanionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M5 5h14v10H9l-4 4z" />
      <path d="M9 9h6M9 12h4" />
    </svg>
  )
}

export const registerRenderer: RegisterRenderer = (host) => {
  host.registerGlobalSurface({
    id: '{{id}}',
    label: '{{displayName}}',
    Icon: CompanionIcon,
    railPlacement: 'inline',
    Component: createCompanion(host),
  })
}
