// The automation editor's agent field groups (item 2042): who runs it, on what,
// and what it may do while nobody is watching.
//
// A field group beside `TriggerFields`, on the same contract: it renders the
// controls and reports the config keys they set, and the editor stays the one
// owner of the form state and the one save path. Nothing here reads or writes
// an automation; every control hands its choice back through `onPatchConfig`.

import { CliModelPickerButton, FOCUS_RING_CLASS, MenuItem, Popover, Select, type SelectItem } from '../../ui'
import { MENU_LIST_CLASS } from '../../ui/menuClasses'
import type { AgentCliCatalogOption } from '../../workspace/newWorkspace/cliRuntimeOptions'
import { useSpecialistRoster } from '../../workspace/agentComposer/useAgentComposer'
import { SpecialistActionIcon } from '../../AppIcons'
import type { SpecialistAction } from '../../../specialists/specialistActions'
import type { AgentCli, SpecialistActionId, SprintEngineCliPermissionPreset } from '../../../types/workspace'

// The permission field's options. Each label states the preset and what it means
// for a run nobody is watching — the control text is the state, so an automation
// on the unattended default reads "Bypass all — runs unattended" without a
// caption explaining it. Bypass carries the warn tone, as it does everywhere else.
const PERMISSION_PRESET_ITEMS: SelectItem<SprintEngineCliPermissionPreset>[] = [
  { value: 'none', label: 'CLI default — whatever the CLI does' },
  { value: 'manual', label: 'Manual — asks before acting' },
  { value: 'auto', label: 'Auto — fewer prompts, CLI-supervised' },
  { value: 'bypass', label: 'Bypass all — runs unattended', tone: 'warn' },
]

// Agent and Model (§.duo): who runs it, and on what. Both resolve to something
// real on an automation with neither set — the agent reads "No role", the runtime
// reads the CLI the launch would actually fall back to — because an enabled
// automation showing an empty picker reads broken.
//
// Agent is a ROLE here, not a spawn: the automation picks which soul runs it,
// and the runtime beside it is CliModelPickerButton — the same control every
// other surface binds a runtime with. The role list is `useSpecialistRoster`,
// the one the spawn picker's Role control reads, so a disabled pack disappears
// from both at once. The choice is persisted into the action config so a
// scheduled run reproduces it.
export function AgentModelFields({
  show,
  config,
  cliCatalog,
  selectedCli,
  selectedSpecialist,
  pickerOpen,
  onPickerOpenChange,
  onPatchConfig,
}: {
  /** The action's schema consumes `cli`, and the action is available. */
  show: boolean
  config: Record<string, string>
  cliCatalog: AgentCliCatalogOption[]
  selectedCli: AgentCli
  selectedSpecialist: SpecialistAction | null
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
  onPatchConfig: (patch: Record<string, string>) => void
}): JSX.Element | null {
  if (!show) return null
  return (
    <div className="grid gap-3 @[520px]:grid-cols-2 @[520px]:items-start">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-meta font-medium text-[color:var(--text-default)]">Agent</span>
        <Popover
          open={pickerOpen}
          onOpenChange={onPickerOpenChange}
          ariaLabel="Choose agent"
          popupRole="menu"
          placement="bottom-start"
          renderTrigger={({ ref, triggerProps, togglePopover }) => (
            <button
              ref={ref}
              type="button"
              aria-label="Choose agent"
              onClick={togglePopover}
              className={`grid w-full grid-cols-[24px_1fr_auto] items-center gap-2.5 rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2.5 py-2 text-left transition-colors hover:border-[color:var(--border-strong)] ${FOCUS_RING_CLASS}`}
              {...triggerProps}
            >
              <span className="flex h-6 w-6 items-center justify-center text-[color:var(--text-muted)]">
                {selectedSpecialist ? (
                  <SpecialistActionIcon icon={selectedSpecialist.icon} className="h-4 w-4" />
                ) : (
                  <svg className="icon-md" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-meta font-medium text-[color:var(--text-strong)]">
                  {selectedSpecialist ? selectedSpecialist.shortLabel : 'No role'}
                </span>
                {/* A role's own description; a roleless agent gets
                    no second line, because the aside's Agent fact
                    already says what it is. */}
                {selectedSpecialist ? (
                  <span className="block truncate text-micro text-[color:var(--text-subtle)]">
                    {selectedSpecialist.description}
                  </span>
                ) : null}
              </span>
              <svg className="icon-sm shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        >
          <RoleMenu
            selectedSpecialistId={(config.specialistId as SpecialistActionId) || null}
            onSelect={(id) => {
              onPatchConfig({ specialistId: id ?? '' })
              onPickerOpenChange(false)
            }}
          />
        </Popover>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-meta font-medium text-[color:var(--text-default)]">Model</span>
        {/* The picker names the model and leaves it unpinned by
            default, so the runtime's own default is what runs. It
            brings its own control box — a second one around it would
            be two borders for one control — so the row only holds it
            at the height of the Agent field beside it. */}
        <div className="flex h-[38px] items-center">
          <CliModelPickerButton
            ariaLabel="Agent runtime and model"
            options={cliCatalog}
            cli={selectedCli}
            effectiveModelFor={(candidate) => (candidate === selectedCli ? config.cliModel || undefined : undefined)}
            onSelectCli={(cli) => onPatchConfig({ cli, cliModel: '' })}
            onSelectModel={(cli, model) => onPatchConfig({ cli, cliModel: model ?? '' })}
          />
        </div>
      </div>
    </div>
  )
}

// The installed roles, plus the roleless run the automation defaults to. The
// runtime is NOT set here — the Model field beside it owns that, so picking a
// role can never quietly rebind which CLI the scheduled run launches.
function RoleMenu({
  selectedSpecialistId,
  onSelect,
}: {
  selectedSpecialistId: SpecialistActionId | null
  onSelect: (id: SpecialistActionId | null) => void
}): JSX.Element {
  const roles = useSpecialistRoster()
  return (
    <div className={`${MENU_LIST_CLASS} min-w-[220px]`}>
      <MenuItem
        selection="one-of"
        checked={selectedSpecialistId === null}
        onClick={() => onSelect(null)}
      >
        No role
      </MenuItem>
      {roles.map((role) => (
        <MenuItem
          key={role.id}
          selection="one-of"
          checked={role.id === selectedSpecialistId}
          icon={<SpecialistActionIcon icon={role.icon} className="icon-sm shrink-0" />}
          onClick={() => onSelect(role.id)}
        >
          {role.shortLabel}
        </MenuItem>
      ))}
    </div>
  )
}

// What the run may do while nobody is watching. It sits beside the trigger
// rather than beside the agent (mockup §.duo "Runs and Permission"), which is
// why it is its own export rather than a third column of the block above.
export function PermissionField({
  show,
  value,
  onChange,
}: {
  show: boolean
  value: SprintEngineCliPermissionPreset
  onChange: (preset: SprintEngineCliPermissionPreset) => void
}): JSX.Element | null {
  if (!show) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-meta font-medium text-[color:var(--text-default)]">Permission</span>
      <Select ariaLabel="Permission" value={value} onChange={onChange} items={PERMISSION_PRESET_ITEMS} />
    </div>
  )
}
