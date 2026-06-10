import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { getRendererHost, selectModuleEnabled } from '../../../modules'
import type { ModuleEnablementOverrides } from '../../../../../shared/modules/manifest'
import { StandardWorkspaceTypeIcon } from '../../AppIcons'
import { ModeCard } from './ModeCard'
import type { ModeCardModel } from './types'

// Mirror how NewWorkspacePanel's mode step builds its list: shell-owned
// 'standard' first, then the registry-contributed types in pickerOrder, gated by
// module enablement. This is the real getWorkspaceTypes + selectModuleEnabled
// path, so the gating assertions below are real-path coverage of AC2.
const STANDARD_MODE_MODEL: ModeCardModel = {
  id: 'standard',
  label: 'Standard',
  description: 'IDE layout with editor, terminals, and file explorer for direct work.',
  icon: StandardWorkspaceTypeIcon,
}

function modeModelsFor(overrides: ModuleEnablementOverrides): ModeCardModel[] {
  return [
    STANDARD_MODE_MODEL,
    ...getRendererHost()
      .getWorkspaceTypes((moduleId) => selectModuleEnabled(overrides, moduleId))
      .map((definition) => ({
        id: definition.id,
        label: definition.label,
        description: definition.description,
        icon: definition.icon,
      })),
  ]
}

// AC1: with all modules enabled the picker shows the same five modes in order.
const allEnabled = modeModelsFor({})
assert.deepEqual(
  allEnabled.map((model) => model.id),
  ['standard', 'switchboard', 'sprintengine', 'multiloop', 'guided-brief'],
  'mode picker lists standard then the contributed types in pickerOrder',
)

// AC1: icon identity, not just "an svg exists". Each card must render its mode's
// canonical glyph; guided-brief in particular must be the brief speech-bubble
// (path starts M5 6.25C5 5.42), never the document glyph (M5 5.5H15.25).
const EXPECTED_ICON_PATH: Record<string, string> = {
  standard: 'M7.25 10L10 12.5L7.25 15',
  switchboard: 'M9 5.5V18.5M15 5.5V18.5',
  sprintengine: 'M10.85 8.2L7.65 14.35',
  multiloop: 'M12 4.5 A7.5 7.5 0 0 1 19.5 12',
  'guided-brief': 'M5 6.25C5 5.42',
}

for (const model of allEnabled) {
  const html = renderToStaticMarkup(<ModeCard model={model} active={false} onSelect={() => {}} />)
  assert.match(html, /role="radio"/, `${model.id} card is a radio`)
  assert.match(html, /aria-checked="false"/, `${model.id} inactive card reports unchecked`)
  assert.ok(html.includes(model.label), `${model.id} card renders its label`)
  assert.ok(html.includes(model.description), `${model.id} card renders its description`)
  assert.ok(html.includes(EXPECTED_ICON_PATH[model.id]), `${model.id} card renders its canonical icon`)
}

// AC1 guard: guided-brief must not regress to the document glyph.
const guidedHtml = renderToStaticMarkup(
  <ModeCard model={allEnabled[4]} active={false} onSelect={() => {}} />,
)
assert.ok(!guidedHtml.includes('M5 5.5H15.25'), 'guided-brief card is the speech-bubble, not the document glyph')

// Selected state flips aria-checked for screen readers.
const activeHtml = renderToStaticMarkup(<ModeCard model={STANDARD_MODE_MODEL} active onSelect={() => {}} />)
assert.match(activeHtml, /aria-checked="true"/, 'active card reports checked')

// AC2 (real-path gating): disabling sprint-engine drops both sprintengine and
// guided-brief (guided-brief is registered under the sprint-engine module);
// disabling multiloop drops multiloop; standard is always present.
const sprintEngineOff = modeModelsFor({ 'sprint-engine': false }).map((model) => model.id)
assert.deepEqual(sprintEngineOff, ['standard', 'switchboard', 'multiloop'], 'disabling sprint-engine hides sprintengine and guided-brief')

const multiloopOff = modeModelsFor({ multiloop: false }).map((model) => model.id)
assert.deepEqual(multiloopOff, ['standard', 'switchboard', 'sprintengine', 'guided-brief'], 'disabling multiloop hides only multiloop')

const switchboardOff = modeModelsFor({ switchboard: false }).map((model) => model.id)
assert.deepEqual(switchboardOff, ['standard', 'sprintengine', 'multiloop', 'guided-brief'], 'disabling switchboard hides only switchboard')

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
