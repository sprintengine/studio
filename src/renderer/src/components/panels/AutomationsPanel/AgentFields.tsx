// The automation editor's agent field groups (item 2042): what it runs on, and
// what it may do while nobody is watching.
//
// A field group beside `TriggerFields`, on the same contract: it renders the
// controls and reports the config keys they set, and the editor stays the one
// owner of the form state and the one save path. Nothing here reads or writes
// an automation; every control hands its choice back through `onPatchConfig`.

import type { JSX } from 'react'
import { CliModelPickerButton, Select, type SelectItem } from '../../ui'
import type { AgentCliCatalogOption } from '../../workspace/newWorkspace/cliRuntimeOptions'
import type { AgentCli, CliPermissionPreset } from '../../../types/workspace'

// The permission field's options. Each label states the preset and what it means
// for a run nobody is watching — the control text is the state, so an automation
// on the unattended default reads "Bypass all — runs unattended" without a
// caption explaining it. Bypass carries the warn tone, as it does everywhere else.
const PERMISSION_PRESET_ITEMS: SelectItem<CliPermissionPreset>[] = [
  { value: 'none', label: 'CLI default — whatever the CLI does' },
  { value: 'manual', label: 'Manual — asks before acting' },
  { value: 'auto', label: 'Auto — fewer prompts, CLI-supervised' },
  { value: 'bypass', label: 'Bypass all — runs unattended', tone: 'warn' },
]

// Model (§.duo): what the automation's agent runs on. It resolves to something
// real on an automation with nothing set — the runtime reads the CLI the launch
// would actually fall back to — because an enabled automation showing an empty
// picker reads broken. The choice is persisted into the action config so a
// scheduled run reproduces it.
export function ModelField({
  show,
  config,
  cliCatalog,
  selectedCli,
  onPatchConfig,
}: {
  /** The action's schema consumes `cli`, and the action is available. */
  show: boolean
  config: Record<string, string>
  cliCatalog: AgentCliCatalogOption[]
  selectedCli: AgentCli
  onPatchConfig: (patch: Record<string, string>) => void
}): JSX.Element | null {
  if (!show) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-meta font-medium text-[color:var(--text-default)]">Model</span>
      {/* The picker names the model and leaves it unpinned by default, so the
          runtime's own default is what runs. It brings its own control box — a
          second one around it would be two borders for one control. */}
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
  value: CliPermissionPreset
  onChange: (preset: CliPermissionPreset) => void
}): JSX.Element | null {
  if (!show) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-meta font-medium text-[color:var(--text-default)]">Permission</span>
      <Select ariaLabel="Permission" value={value} onChange={onChange} items={PERMISSION_PRESET_ITEMS} />
    </div>
  )
}
