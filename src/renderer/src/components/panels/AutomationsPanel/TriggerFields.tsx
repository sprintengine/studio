import { useState } from 'react'

import { ChipButton, Field, GhostButton, InlineNotice, Input, Select, type SelectItem, Switch } from '../../ui'
import type { AutomationDefinition, AutomationsProviders, TriggerKind } from '../../../../../shared/automations/contracts'
import { foreignScheduleTimeZone } from '../../../../../shared/automations/cadence'
import {
  REPO_EVENT_TRIGGER_KIND,
  SCHEDULE_TRIGGER_KIND,
  TRIGGER_FAMILY_LABEL,
  WEBHOOK_ROUTE_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TRIGGER_KIND,
  WEEKDAY_SHORT,
  cadenceSummary,
  contributorModuleIdFromKind,
  generateWebhookSecret,
  isAuthorableTrigger,
  isScheduleConfig,
  missingProviderReason,
  providerUnavailableReason,
  type EditorState,
  type RepoEventForm,
  type RepoEventProvider,
  type RepoEventType,
  type ScheduleCadenceForm,
  type ScheduleCadenceType,
  type WebhookForm,
} from './automationsFormat'

// The trigger families the picker always offers, in priority order. Each is shown
// even when unavailable (disabled + reason) so a control boundary is never hidden.
const CANONICAL_FAMILIES: TriggerKind[] = [
  SCHEDULE_TRIGGER_KIND,
  REPO_EVENT_TRIGGER_KIND,
  WEBHOOK_TRIGGER_KIND,
]

// The picker's family label is the one canonical TRIGGER_FAMILY_LABEL map (shared
// with the list's supporting line, so the two can't drift), falling back to the
// raw kind for unknown third-party families.
function familyLabel(kind: TriggerKind, providers: AutomationsProviders | null): string {
  const fromProvider = providers?.triggers.find((entry) => entry.kind === kind)?.label
  return fromProvider ?? TRIGGER_FAMILY_LABEL[kind] ?? kind
}

// The control box is `ui/Input`. This file used to declare its own copy of
// `AutomationEditor.CONTROL_BASE` — the same string, in two files, under
// comments in both saying they were hand-synced (MC-2114).
//
// What remains here is WIDTH, which is a per-field measure rather than a
// vocabulary: a HH:MM control and a full date-and-time control hold different
// content and cannot be the same width. Each passes `fullWidth={false}` with its
// own measure, because Tailwind resolves two width utilities by stylesheet order
// rather than by the order they appear in a class string.
const NARROW_CONTROL = 'w-32 tabular-nums'
// Wider than the HH:MM control: a datetime-local renders full date + time
// segments plus the picker glyph.
const DATETIME_CONTROL = 'w-52 tabular-nums'

// Composes ScheduleCadenceForm so a new cadence field has exactly one
// authoritative declaration (automationsFormat.ts) instead of parallel copies.
export type TriggerFieldsValue = ScheduleCadenceForm & {
  triggerKind: TriggerKind
  repoEvent: RepoEventForm
  webhook: WebhookForm
}

// Reason a trigger family cannot be authored. schedule/webhook are always
// registered; repo-event and every module-contributed family depend on a module
// or a connected integration, so their absence from providers.triggers is
// surfaced explicitly rather than hiding the family.
function familyUnavailableReason(kind: TriggerKind, providers: AutomationsProviders | null): string | null {
  if (!providers) return null
  const provider = providers.triggers.find((t) => t.kind === kind)
  if (!provider) {
    if (kind === REPO_EVENT_TRIGGER_KIND) return 'This trigger needs a module that syncs GitHub or Jira issues into this project, and none is connected.'
    if (contributorModuleIdFromKind(kind)) return missingProviderReason(kind, 'trigger')
    return null
  }
  return providerUnavailableReason(provider, 'trigger')
}

export function selectedFamilyUnavailableReason(
  kind: TriggerKind,
  providers: AutomationsProviders | null,
): string | null {
  return familyUnavailableReason(kind, providers)
}

export function TriggerFields({
  editor, providers, value, onChange,
}: {
  editor: EditorState
  providers: AutomationsProviders | null
  value: TriggerFieldsValue
  onChange: (patch: Partial<TriggerFieldsValue>) => void
}) {
  const loaded = editor.mode === 'edit' ? editor.definition.trigger : null

  // A loaded cron schedule or unknown third-party family has no authoring control
  // (the engine rejects cron); show its read-only summary and round-trip verbatim.
  if (loaded && !isAuthorableTrigger(loaded)) {
    return (
      <fieldset className="flex flex-col gap-3">
        <legend className="text-meta font-medium text-[color:var(--text-default)]">When it runs</legend>
        <div className="flex flex-col gap-1">
          <span className="text-meta text-[color:var(--text-default)]">{cadenceSummary(loaded)}</span>
          <span className="text-micro text-[color:var(--text-subtle)]">
            Editing this trigger type isn’t supported yet. Saving keeps the current trigger unchanged.
          </span>
        </div>
      </fieldset>
    )
  }

  const pickerKinds: TriggerKind[] = []
  const seen = new Set<string>()
  const pushKind = (kind: TriggerKind) => {
    if (seen.has(kind)) return
    seen.add(kind)
    pickerKinds.push(kind)
  }
  for (const kind of CANONICAL_FAMILIES) pushKind(kind)
  for (const trigger of providers?.triggers ?? []) pushKind(trigger.kind)
  if (editor.mode === 'edit') pushKind(editor.definition.trigger.kind)

  const familyItems: SelectItem[] = pickerKinds.map((kind) => {
    const reason = familyUnavailableReason(kind, providers)
    return {
      value: kind,
      label: reason ? `${familyLabel(kind, providers)} — unavailable` : familyLabel(kind, providers),
      disabled: Boolean(reason),
    }
  })
  const selectedReason = familyUnavailableReason(value.triggerKind, providers)

  return (
    <fieldset className="flex flex-col gap-3">
      {/* The group's name IS the first control's label — "Trigger" above "When
          it runs" above a Select reading "Schedule" was the same fact in three
          type tiers, and it put a second label tier in a field row that pairs
          with single-labelled controls. */}
      <legend className="text-meta font-medium text-[color:var(--text-default)]">When it runs</legend>

      <Select
        ariaLabel="Trigger family"
        value={value.triggerKind}
        onChange={(kind) => onChange({ triggerKind: kind })}
        items={familyItems}
      />

      {selectedReason ? <InlineNotice tone="warn">{selectedReason}</InlineNotice> : null}

      {value.triggerKind === SCHEDULE_TRIGGER_KIND ? (
        <ScheduleFields value={value} onChange={onChange} writtenTimeZone={loadedScheduleForeignZone(loaded)} />
      ) : value.triggerKind === REPO_EVENT_TRIGGER_KIND ? (
        <RepoEventFields value={value.repoEvent} onChange={(repoEvent) => onChange({ repoEvent })} />
      ) : value.triggerKind === WEBHOOK_TRIGGER_KIND ? (
        <WebhookFields value={value.webhook} onChange={(webhook) => onChange({ webhook })} />
      ) : null}
    </fieldset>
  )
}

// The zone a loaded schedule's wall-clock is read in, when that is not this
// machine's. A save preserves the loaded zone (`resolveSubmitTrigger`), so the
// field below must say which clock it is on rather than claiming "local" — and a
// new automation, or one installed since catalogue schedules became local (item
// 2039), is already in this zone and gets nothing extra.
function loadedScheduleForeignZone(loaded: AutomationDefinition['trigger'] | null): string | null {
  if (!loaded || loaded.kind !== SCHEDULE_TRIGGER_KIND || !isScheduleConfig(loaded.config)) return null
  return foreignScheduleTimeZone(loaded.config, Intl.DateTimeFormat().resolvedOptions().timeZone)
}

function ScheduleFields({
  value, onChange, writtenTimeZone,
}: {
  value: TriggerFieldsValue
  onChange: (patch: Partial<TriggerFieldsValue>) => void
  /** The zone this schedule's wall-clock is read in, when it is not the reader's. */
  writtenTimeZone: string | null
}) {
  return (
    <>
      <Field label="Cadence" htmlFor="automation-cadence">
        <Select<ScheduleCadenceType>
          ariaLabel="Cadence"
          value={value.cadenceType}
          onChange={(cadenceType) => onChange({ cadenceType })}
          items={[
            { value: 'interval', label: 'Every N minutes' },
            { value: 'daily', label: 'Daily' },
            { value: 'weekly', label: 'Weekly' },
            { value: 'at', label: 'Once, at a date and time' },
          ]}
        />
      </Field>
      {value.cadenceType === 'interval' ? (
        <Field label="Run every (minutes)" htmlFor="automation-interval" help="Minimum 5 minutes.">
          <Input
            id="automation-interval"
            type="number"
            min={5}
            value={value.everyMinutes}
            onChange={(e) => onChange({ everyMinutes: Number(e.target.value) || 0 })}
            fullWidth={false}
            className={NARROW_CONTROL}
          />
        </Field>
      ) : value.cadenceType === 'at' ? (
        <Field
          label="Date and time"
          htmlFor="automation-at-datetime"
          help={
            writtenTimeZone
              ? `In ${writtenTimeZone}. Runs once, then stays listed with no upcoming run.`
              : 'Runs once, then stays listed with no upcoming run.'
          }
        >
          <Input
            id="automation-at-datetime"
            type="datetime-local"
            value={value.atDatetime}
            onChange={(e) => onChange({ atDatetime: e.target.value })}
            fullWidth={false}
            className={`${DATETIME_CONTROL} time-control`}
          />
        </Field>
      ) : (
        <Field
          label="Time"
          htmlFor="automation-time"
          help={writtenTimeZone ? `24-hour (HH:MM), in ${writtenTimeZone}.` : 'Local time, 24-hour (HH:MM).'}
        >
          <Input
            id="automation-time"
            type="time"
            value={value.timeLocal}
            onChange={(e) => onChange({ timeLocal: e.target.value })}
            fullWidth={false}
            className={`${NARROW_CONTROL} time-control`}
          />
        </Field>
      )}
      {value.cadenceType === 'weekly' ? (
        <fieldset>
          <legend className="mb-1 text-micro text-[color:var(--text-subtle)]">Days</legend>
          <div className="flex flex-wrap gap-1">
            {WEEKDAY_SHORT.map((label, day) => {
              const checked = value.daysOfWeek.includes(day)
              return (
                <ChipButton
                  key={day}
                  variant="outline"
                  pressed={checked}
                  onClick={() => onChange({ daysOfWeek: checked ? value.daysOfWeek.filter((d) => d !== day) : [...value.daysOfWeek, day] })}
                  className="min-w-9 justify-center"
                >
                  {label}
                </ChipButton>
              )
            })}
          </div>
        </fieldset>
      ) : null}
    </>
  )
}

const REPO_EVENT_PROVIDERS: { value: RepoEventProvider; label: string }[] = [
  { value: 'any', label: 'Any source' },
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
]
const REPO_EVENT_TYPES: { value: RepoEventType; label: string }[] = [
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Updated' },
]

function RepoEventFields({
  value, onChange,
}: {
  value: RepoEventForm
  onChange: (next: RepoEventForm) => void
}) {
  return (
    <>
      <Field label="Source" htmlFor="automation-repo-provider" help="Which connected source emits the event.">
        <Select<RepoEventProvider>
          ariaLabel="Event source"
          value={value.provider}
          onChange={(provider) => onChange({ ...value, provider })}
          items={REPO_EVENT_PROVIDERS}
        />
      </Field>
      {/* No `htmlFor`: the row is a chip group, not one labellable control, and
          the group names itself. Passing one put the id on this div and left the
          label addressing an element that cannot be labelled. */}
      <Field label="Event types" help="Fire when a matching item is created or updated.">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Event types">
          {REPO_EVENT_TYPES.map((event) => {
            const checked = value.eventTypes.includes(event.value)
            return (
              <ChipButton
                key={event.value}
                variant="outline"
                pressed={checked}
                onClick={() => onChange({
                  ...value,
                  eventTypes: checked
                    ? value.eventTypes.filter((e) => e !== event.value)
                    : [...value.eventTypes, event.value],
                })}
                className="min-w-9 justify-center"
              >
                {event.label}
              </ChipButton>
            )
          })}
        </div>
      </Field>
      <Field label="External key" htmlFor="automation-repo-key" help="Optional. Match a specific issue or PR key, e.g. PROJ-12.">
        <Input
          id="automation-repo-key"
          value={value.externalKey}
          onChange={(e) => onChange({ ...value, externalKey: e.target.value })}
        />
      </Field>
      <Field label="Label" htmlFor="automation-repo-label" help="Optional. A human label for this event source.">
        <Input
          id="automation-repo-label"
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
        />
      </Field>
    </>
  )
}

function WebhookFields({
  value, onChange,
}: {
  value: WebhookForm
  onChange: (next: WebhookForm) => void
}) {
  const [copied, setCopied] = useState(false)

  const copySecret = async () => {
    try {
      await window.api.clipboardWriteText(value.secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const regenerate = () => {
    setCopied(false)
    onChange({ ...value, secret: generateWebhookSecret() })
  }

  const deliveryPath = value.path.trim()

  return (
    <>
      <label className="flex items-center gap-2 text-meta text-[color:var(--text-default)]">
        <Switch
          checked={value.enabled}
          onChange={(enabled) => onChange({ ...value, enabled })}
          ariaLabel="Enable inbound webhook delivery"
        />
        Listen for deliveries
        <span className="text-micro text-[color:var(--text-subtle)]">{value.enabled ? '(receiver active)' : '(paused)'}</span>
      </label>
      <Field label="Port" htmlFor="automation-webhook-port" help="Local port the receiver listens on.">
        <Input
          id="automation-webhook-port"
          type="number"
          min={0}
          max={65535}
          value={value.port}
          onChange={(e) => onChange({ ...value, port: e.target.value })}
          fullWidth={false}
          className={NARROW_CONTROL}
        />
      </Field>
      <Field label="Path" htmlFor="automation-webhook-path" help="Path segment after the delivery prefix.">
        <Input
          id="automation-webhook-path"
          value={value.path}
          onChange={(e) => onChange({ ...value, path: e.target.value })}
          placeholder="deploy"
        />
      </Field>
      <div className="text-micro text-[color:var(--text-subtle)]">
        Delivery URL{' '}
        <code className="font-mono text-[color:var(--text-muted)]">{WEBHOOK_ROUTE_PREFIX}{deliveryPath || '<path>'}</code>
      </div>

      {/* No `htmlFor`: both branches are composites. With one, the cloned id
          landed on the wrapper div AND the field below carried the same id, so
          the document held it twice and the label resolved to the div. */}
      <Field label="Secret" help="Used to sign deliveries. Shown once when generated.">
        {value.secret ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Input
                id="automation-webhook-secret"
                aria-label="Webhook secret"
                readOnly
                value={value.secret}
                className="font-mono"
              />
              <GhostButton type="button" onClick={() => void copySecret()} className="h-7 shrink-0 px-2 text-micro">
                {copied ? 'Copied' : 'Copy'}
              </GhostButton>
            </div>
            <span className="text-micro text-[color:var(--tone-warn)]">
              Copy this now — it won’t be shown again after you save.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <GhostButton type="button" onClick={regenerate} className="h-7 px-2 text-micro">
              {value.hasSecret ? 'Regenerate secret' : 'Generate secret'}
            </GhostButton>
            <span className="text-micro text-[color:var(--text-subtle)]">
              {value.hasSecret ? 'A secret is set. Regenerate to replace it.' : 'No secret yet.'}
            </span>
          </div>
        )}
      </Field>

      <p className="text-micro leading-5 text-[color:var(--text-subtle)]">
        Sign the raw request body with HMAC-SHA256 using the secret and send it in the{' '}
        <code className="font-mono text-[color:var(--text-muted)]">{WEBHOOK_SIGNATURE_HEADER}</code> header as{' '}
        <code className="font-mono text-[color:var(--text-muted)]">sha256=&lt;hex&gt;</code>.
      </p>
    </>
  )
}
