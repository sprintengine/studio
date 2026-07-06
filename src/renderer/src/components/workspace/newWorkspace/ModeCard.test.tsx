import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { getRendererHost, selectModuleEnabled } from '../../../modules'
import type { ModuleEnablementOverrides } from '../../../../../shared/modules/manifest'
import { CommentIcon, StandardWorkspaceTypeIcon } from '../../AppIcons'
import { ModeCard } from './ModeCard'
import type { ModeCardModel } from './types'

// Mirror how NewWorkspacePanel's mode step builds its list (T2): lead with the
// shell-owned Chat pseudo-card, then surface Sprint Engine and Design Wizard,
// then the shell-owned Standard card, then the remaining registry-contributed
// types in pickerOrder — all gated by module enablement. This is the real
// getWorkspaceTypes + selectModuleEnabled path, so the gating assertions are
// real-path coverage of AC1/AC2.
const CHAT_MODE_MODEL: ModeCardModel = {
  id: 'chat',
  label: 'Chat',
  description: 'A single agent you chat with, scoped to this project.',
  icon: CommentIcon,
}
const STANDARD_MODE_MODEL: ModeCardModel = {
  id: 'standard',
  label: 'Standard',
  description: 'IDE layout with editor, terminals, and file explorer for direct work.',
  icon: StandardWorkspaceTypeIcon,
}

const FEATURED_IDS = ['sprintengine', 'guided-brief']

function modeModelsFor(overrides: ModuleEnablementOverrides): ModeCardModel[] {
  const contributed = getRendererHost()
    .getWorkspaceTypes((moduleId) => selectModuleEnabled(overrides, moduleId))
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      icon: definition.icon,
    }))
  const byId = new Map(contributed.map((model) => [model.id, model]))
  const featured = FEATURED_IDS.map((id) => byId.get(id)).filter(
    (model): model is ModeCardModel => model !== undefined,
  )
  const rest = contributed.filter((model) => !FEATURED_IDS.includes(model.id))
  return [CHAT_MODE_MODEL, ...featured, STANDARD_MODE_MODEL, ...rest]
}

// The 'automations-host' workspace type is being migrated to a global screen in a
// sibling task; while its registration lingers it still returns from
// getWorkspaceTypes. This picker-ordering contract is agnostic to that migration,
// so it compares the card ids with automations-host excluded.
const contractIds = (models: ModeCardModel[]) =>
  models.map((model) => model.id).filter((id) => id !== 'automations-host')

// AC1: Chat leads, then Sprint Engine and Design Wizard, then Standard, then the
// remaining contributed types (Switchboard/Multiloop) in pickerOrder.
const allEnabled = modeModelsFor({})
assert.deepEqual(
  contractIds(allEnabled),
  ['chat', 'sprintengine', 'guided-brief', 'standard', 'switchboard', 'multiloop'],
  'mode picker leads with Chat, then the featured types, then Standard and the rest',
)
assert.equal(contractIds(allEnabled)[0], 'chat', 'Chat is always the first card')

// AC1: icon identity, not just "an svg exists". Each card must render its mode's
// canonical glyph; guided-brief in particular must be the brief speech-bubble
// (path starts M5 6.25C5 5.42), never the document glyph (M5 5.5H15.25). Chat is
// the comment speech-bubble (M5 6.5C5 5.95).
const EXPECTED_ICON_PATH: Record<string, string> = {
  chat: 'M5 6.5C5 5.95 5.45 5.5',
  standard: 'M7.25 10L10 12.5L7.25 15',
  switchboard: 'M9 5.5V18.5M15 5.5V18.5',
  sprintengine: 'M10.85 8.2L7.65 14.35',
  multiloop: 'M12 4.5 A7.5 7.5 0 0 1 19.5 12',
  'guided-brief': 'M5 6.25C5 5.42',
}

// Render contract for every card in the ordering contract (automations-host is
// excluded above and has no entry in EXPECTED_ICON_PATH).
for (const model of allEnabled.filter((m) => m.id !== 'automations-host')) {
  const html = renderToStaticMarkup(<ModeCard model={model} active={false} onSelect={() => {}} />)
  assert.match(html, /role="radio"/, `${model.id} card is a radio`)
  assert.match(html, /aria-checked="false"/, `${model.id} inactive card reports unchecked`)
  assert.ok(html.includes(model.label), `${model.id} card renders its label`)
  assert.ok(html.includes(model.description), `${model.id} card renders its description`)
  assert.ok(html.includes(EXPECTED_ICON_PATH[model.id]), `${model.id} card renders its canonical icon`)
}

// AC1 guard: guided-brief must not regress to the document glyph.
const guidedModel = allEnabled.find((model) => model.id === 'guided-brief')!
const guidedHtml = renderToStaticMarkup(<ModeCard model={guidedModel} active={false} onSelect={() => {}} />)
assert.ok(!guidedHtml.includes('M5 5.5H15.25'), 'guided-brief card is the speech-bubble, not the document glyph')

// AC5: the selected card carries a single accent — it flips aria-checked and
// renders the check badge; unselected cards render no check.
const activeHtml = renderToStaticMarkup(<ModeCard model={STANDARD_MODE_MODEL} active onSelect={() => {}} />)
assert.match(activeHtml, /aria-checked="true"/, 'active card reports checked')
assert.ok(activeHtml.includes('M4 8.5L6.5 11L12 5'), 'active card renders the accent check glyph')
const inactiveHtml = renderToStaticMarkup(<ModeCard model={STANDARD_MODE_MODEL} active={false} onSelect={() => {}} />)
assert.ok(!inactiveHtml.includes('M4 8.5L6.5 11L12 5'), 'inactive card renders no check glyph')

// AC2 (real-path gating): disabling sprint-engine drops both sprintengine and
// guided-brief (guided-brief is registered under the sprint-engine module);
// disabling multiloop/switchboard drops only that one; Chat and Standard persist.
const sprintEngineOff = contractIds(modeModelsFor({ 'sprint-engine': false }))
assert.deepEqual(sprintEngineOff, ['chat', 'standard', 'switchboard', 'multiloop'], 'disabling sprint-engine hides sprintengine and guided-brief')

const multiloopOff = contractIds(modeModelsFor({ multiloop: false }))
assert.deepEqual(multiloopOff, ['chat', 'sprintengine', 'guided-brief', 'standard', 'switchboard'], 'disabling multiloop hides only multiloop')

const switchboardOff = contractIds(modeModelsFor({ switchboard: false }))
assert.deepEqual(switchboardOff, ['chat', 'sprintengine', 'guided-brief', 'standard', 'multiloop'], 'disabling switchboard hides only switchboard')

// A registry id outside the known card-style set still renders (neutral style
// fallback) rather than throwing, matching the open WorkspaceMode contract.
const unknownHtml = renderToStaticMarkup(
  <ModeCard
    model={{ id: 'future-plugin-mode', label: 'Future', description: 'Plugin-contributed mode.', icon: StandardWorkspaceTypeIcon }}
    active
    onSelect={() => {}}
  />,
)
assert.ok(unknownHtml.includes('Future'), 'unknown registry id renders with the neutral fallback style')

console.log('mode card render tests passed')
