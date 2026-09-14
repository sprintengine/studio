// Settings → Agents → Text generation: whether chat titles are written by the
// person's own agent CLI, and which CLI, model and effort do the writing.
//
// The picker is the same control every launch surface uses, filtered to the
// CLIs that have a headless backend (TEXT_GENERATION_BACKENDS), so a person
// cannot pick a runtime that cannot answer. When no engine is chosen the row
// shows what will actually run — the first supported installed CLI at its
// cheap default — rather than an empty trigger, because that IS the choice
// in force. The copy names whose quota it spends: the honesty rule of
// MC-2484, the cost is theirs.

import { useMemo } from 'react'

import {
  resolveTextGenerationEngine,
  supportsTextGeneration,
  type TextGenerationEngine,
} from '../../../../shared/text-generation/contract'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'
import { CliModelPickerButton } from '../ui'
import { selectAgentCliCatalog } from '../workspace/newWorkspace/cliRuntimeOptions'
import { SettingCard, SettingsRow, SettingsSectionTitle, SettingToggle } from './SettingsAtoms'

export function TextGenerationSettingsSection(): JSX.Element {
  const textGeneration = useWorkspaceStore((s) => s.appSettings.textGeneration)
  const setTextGenerationEnabled = useWorkspaceStore((s) => s.setTextGenerationEnabled)
  const setTextGenerationEngine = useWorkspaceStore((s) => s.setTextGenerationEngine)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const hostedModelCatalogs = useWorkspaceStore((s) => s.hostedModelCatalogs)

  // Installed CLIs with a backend, in catalog order. Availability filtering
  // hides only an explicit not-installed, like every deployment picker.
  const options = useMemo(
    () =>
      selectAgentCliCatalog(
        pluginCatalogStatus,
        pluginCatalogEntries,
        cliRuntimes,
        { map: cliAvailability, status: cliAvailabilityStatus },
        cliModelCatalog,
        hostedModelCatalogs,
      ).filter((option) => supportsTextGeneration(option.value)),
    [
      pluginCatalogStatus,
      pluginCatalogEntries,
      cliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
      cliModelCatalog,
      hostedModelCatalogs,
    ],
  )

  // What a title request made right now would run on: the stored choice when
  // its CLI is here, else the first supported installed CLI at its default.
  const effective = useMemo<TextGenerationEngine | null>(
    () =>
      resolveTextGenerationEngine(
        { ...textGeneration, enabled: true },
        options.map((option) => option.value),
        (cli) => cliAvailability?.[cli]?.installed,
      ),
    [textGeneration, options, cliAvailability],
  )

  const stored = textGeneration.engine
  const noRuntime = options.length === 0

  const modelFor = (cli: AgentCli): string | undefined => {
    if (stored?.cli === cli) return stored.model || effective?.model
    return effective?.cli === cli ? effective.model : undefined
  }
  const reasoningFor = (cli: AgentCli): string | undefined => {
    if (stored?.cli === cli) return stored.reasoning ?? effective?.reasoning
    return effective?.cli === cli ? effective.reasoning : undefined
  }

  return (
    // No top rule on the section: the card draws its own edge.
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>Text generation</SettingsSectionTitle>
      <SettingCard>
        <SettingToggle
          label="Name chats with your agent"
          description="A few words per chat, written by the CLI you already run under its own login. It counts against that subscription. Off, or with no supported CLI installed, the first words of your prompt name the chat."
          enabled={textGeneration.enabled}
          onChange={setTextGenerationEnabled}
          requirement={noRuntime ? 'Needs Claude Code or Codex' : undefined}
        />
        <SettingsRow
          label="Text generation model"
          help="Used for chat titles. A small model at low effort is plenty, and costs a fraction of a turn."
        >
          {noRuntime || !effective ? (
            <span className="text-body text-[color:var(--text-muted)]">No supported CLI installed</span>
          ) : (
            <CliModelPickerButton
              ariaLabel="Text generation model"
              options={options}
              cli={effective.cli}
              disabled={!textGeneration.enabled}
              effectiveModelFor={modelFor}
              effectiveReasoningFor={reasoningFor}
              onSelectReasoning={(cli, reasoning) =>
                // An empty level is an explicit clear; leaving it undefined
                // would tell the setter to keep the stored one.
                setTextGenerationEngine({ cli, model: modelFor(cli) ?? '', reasoning: reasoning ?? '' })
              }
              onSelectCli={(cli) => setTextGenerationEngine({ cli, model: '' })}
              onSelectModel={(cli, model) => setTextGenerationEngine({ cli, model: model ?? '' })}
            />
          )}
        </SettingsRow>
      </SettingCard>
    </section>
  )
}
