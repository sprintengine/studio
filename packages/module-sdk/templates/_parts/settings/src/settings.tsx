import type { RendererHost, SettingsSectionProps } from '@sprintengine/module-sdk'
import { Field, Input } from '@sprintengine/module-sdk/ui'

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  )
}

function Settings({ values, setValue }: SettingsSectionProps) {
  return (
    <Field label="Label" htmlFor="{{id}}-label" help="Shown wherever {{displayName}} names itself.">
      <Input
        id="{{id}}-label"
        value={typeof values.label === 'string' ? values.label : ''}
        onChange={(event) => setValue('label', event.target.value || undefined)}
      />
    </Field>
  )
}

// A section in Settings. Its values are saved in the module's own settings
// namespace — the keys `host.getModuleAppState` reads — so the rest of the
// window half reads them with no wiring of its own ("storage" permission).
export function registerSettings(host: RendererHost): void {
  host.registerSettingsSection({
    id: '{{id}}-settings',
    label: '{{displayName}}',
    description: 'How {{displayName}} behaves.',
    icon: SettingsIcon,
    Component: Settings,
  })
}
