// The automation editor's agent field groups (item 2042): what it runs on, and
// what it may do while nobody is watching.
//
// A field group beside `TriggerFields`, on the same contract: it renders the
// controls and reports the config keys they set, and the editor stays the one
// owner of the form state and the one save path. Nothing here reads or writes
// an automation; every control hands its choice back through `onPatchConfig`.

import type { JSX } from 'react'
import { CliModelPickerButton, Select } from '../../ui'
import { agentPermissionOptions } from '../../workspace/agentComposer/agentSpawnShared'
import type { AgentCliCatalogOption } from '../../workspace/newWorkspace/cliRuntimeOptions'
import type { AgentCli, CliPermissionPreset } from '../../../types/workspace'

// The permission field names the selected runtime's policy. Its summary makes
// the unattended behavior visible, and bypass carries the shared warn tone.

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
  cli,
  show,
  value,
  onChange,
}: {
  cli?: AgentCli
  show: boolean
  value: CliPermissionPreset
  onChange: (preset: CliPermissionPreset) => void
}): JSX.Element | null {
  if (!show) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-meta font-medium text-[color:var(--text-default)]">Permission</span>
      <Select
        ariaLabel="Permission"
        value={value}
        onChange={onChange}
        items={agentPermissionOptions(cli).map((option) => ({
          value: option.value,
          label: `${option.label} — ${option.summary}`,
          ...(option.value === 'bypass' ? { tone: 'warn' as const } : {}),
        }))}
      />
    </div>
  )
}
