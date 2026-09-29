import type { SettingsSectionProps } from '@sprintengine/module-sdk'
import { Field, Input, SegmentedControl, type SegmentedControlItem } from '@sprintengine/module-sdk/ui'

type Tone = 'plain' | 'warm'

const TONES: SegmentedControlItem<Tone>[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'warm', label: 'Warm' },
]

const asTone = (value: unknown): Tone => (value === 'warm' ? 'warm' : 'plain')

export function greetingFrom(values: Readonly<Record<string, unknown>>): string {
  const name = typeof values.name === 'string' && values.name.trim() ? values.name.trim() : 'there'
  return asTone(values.tone) === 'warm' ? `Good to see you, ${name}!` : `Hello, ${name}.`
}

export function SettingsSection({ values, setValue }: SettingsSectionProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Field label="Your name" htmlFor="{{id}}-name" help="Used in the greeting.">
        <Input
          id="{{id}}-name"
          value={typeof values.name === 'string' ? values.name : ''}
          onChange={(event) => setValue('name', event.target.value || undefined)}
        />
      </Field>
      <Field label="Tone">
        <SegmentedControl
          ariaLabel="Tone"
          items={TONES}
          value={asTone(values.tone)}
          onChange={(tone) => setValue('tone', tone)}
        />
      </Field>
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>Preview: {greetingFrom(values)}</p>
    </div>
  )
}
