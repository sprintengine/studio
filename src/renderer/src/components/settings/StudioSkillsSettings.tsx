import { useState, type JSX } from 'react'

import { STUDIO_AREA_SKILLS, type StudioAreaSkillId } from '../../../../shared/studio-area-skills'
import { setStudioAreaSkillEnabled, useStudioAreaSkillChoices } from '../../store/studioAreaSkillsStore'
import { InlineNotice, SettingCard, Spinner } from '../ui'
import { SettingsSectionTitle, SettingToggle } from './SettingsAtoms'

/**
 * The built-in plugin's area skills, one switch each (shared/studio-area-skills.ts).
 *
 * Off by default. A skill is a standing instruction to every agent that can
 * see it, so it is one the person chose: each surface offers its own the first
 * time it is opened, and this is where all six can be changed — the Workspaces
 * skill only here, since it has no surface of its own. A switch applies to
 * every workspace and reaches the next agent launched.
 */
export function StudioSkillsSettings(): JSX.Element {
  const choices = useStudioAreaSkillChoices()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<StudioAreaSkillId>()

  function toggle(skillId: StudioAreaSkillId, enabled: boolean) {
    setPending(skillId)
    setError(undefined)
    setStudioAreaSkillEnabled(skillId, enabled)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setPending(undefined))
  }

  return (
    <section className="space-y-3 pt-2" aria-labelledby="studio-skills-title">
      <SettingsSectionTitle id="studio-skills-title" count={choices?.enabled.length}>
        Studio skills
      </SettingsSectionTitle>
      <p className="text-body text-[color:var(--text-muted)]">
        Skills that teach agents to use this app. An agent only sees the ones switched on, in every workspace, from its
        next launch.
      </p>
      {error ? (
        <InlineNotice tone="error" title="That change was not saved." hint="Switch it again to retry." detail={error} />
      ) : null}
      {!choices ? (
        <Spinner label="Loading Studio skills" />
      ) : (
        <SettingCard>
          {STUDIO_AREA_SKILLS.map((skill) => (
            <SettingToggle
              key={skill.id}
              label={skill.name}
              description={skill.gives}
              enabled={choices.enabled.includes(skill.id)}
              disabled={pending === skill.id}
              onChange={(next) => toggle(skill.id, next)}
            />
          ))}
        </SettingCard>
      )}
    </section>
  )
}
