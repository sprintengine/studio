import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ModuleEnablementOverrides } from '../../../../../shared/modules/manifest'
import { CreationRail } from './CreationRail'
import { buildModeModels } from './modeModels'

// The creation hub rail's type list comes from buildModeModels: the shell-owned
// Chat and Workspace entries lead, then Sprint Engine and Design Wizard are
// featured ahead of the remaining registry-contributed types in pickerOrder —
// all gated by module enablement. This is the real getWorkspaceTypes +
// selectModuleEnabled path, so the gating assertions are real-path coverage.

// The 'automations-host' workspace type is being migrated to a global screen in a
// sibling task; while its registration lingers it still returns from
// getWorkspaceTypes. This ordering contract is agnostic to that migration, so it
// compares ids with automations-host excluded.
const contractIds = (overrides: ModuleEnablementOverrides) =>
  buildModeModels(overrides)
    .map((model) => model.id)
    .filter((id) => id !== 'automations-host')

// AC1: Chat and Workspace lead, then Sprint Engine and Design Wizard, then the
// remaining contributed types (Switchboard/Multiloop) in pickerOrder.
assert.deepEqual(
  contractIds({}),
  ['chat', 'standard', 'sprintengine', 'guided-brief', 'switchboard', 'multiloop'],
  'rail leads with Chat + Workspace, then the featured types, then the rest',
)
assert.equal(contractIds({})[0], 'chat', 'Chat is always the first rail entry')

// AC2 (real-path gating): disabling sprint-engine drops both sprintengine and
// guided-brief (guided-brief is registered under the sprint-engine module);
// disabling multiloop/switchboard drops only that one; Chat and Workspace persist.
assert.deepEqual(
  contractIds({ 'sprint-engine': false }),
  ['chat', 'standard', 'switchboard', 'multiloop'],
  'disabling sprint-engine hides sprintengine and guided-brief',
)
assert.deepEqual(
  contractIds({ multiloop: false }),
  ['chat', 'standard', 'sprintengine', 'guided-brief', 'switchboard'],
  'disabling multiloop hides only multiloop',
)
assert.deepEqual(
  contractIds({ switchboard: false }),
  ['chat', 'standard', 'sprintengine', 'guided-brief', 'multiloop'],
  'disabling switchboard hides only switchboard',
)

// AC3: icon identity, not just "an svg exists". Each rail row must render its
// mode's canonical glyph; guided-brief in particular must be the brief
// speech-bubble (path starts M5 6.25C5 5.42), never the document glyph
// (M5 5.5H15.25). Chat is the comment speech-bubble (M5 6.5C5 5.95).
const EXPECTED_ICON_PATH: Record<string, string> = {
  chat: 'M5 6.5C5 5.95 5.45 5.5',
  standard: 'M7.25 10L10 12.5L7.25 15',
  switchboard: 'M9 5.5V18.5M15 5.5V18.5',
  sprintengine: 'M10.85 8.2L7.65 14.35',
  multiloop: 'M12 4.5 A7.5 7.5 0 0 1 19.5 12',
  'guided-brief': 'M5 6.25C5 5.42',
}

const allModels = buildModeModels({}).filter((model) => model.id !== 'automations-host')
const railHtml = renderToStaticMarkup(
  <CreationRail models={allModels} mode="standard" onSelect={() => {}} />,
)
assert.match(railHtml, /role="tablist"/, 'rail is a tablist')
assert.match(railHtml, /aria-orientation="vertical"/, 'rail is vertical')
for (const model of allModels) {
  assert.ok(railHtml.includes(model.label), `${model.id} row renders its label`)
  assert.ok(railHtml.includes(EXPECTED_ICON_PATH[model.id]), `${model.id} row renders its canonical icon`)
}
assert.ok(!railHtml.includes('M5 5.5H15.25'), 'guided-brief row is the speech-bubble, not the document glyph')

// AC4: exactly one row is selected; selection reads through aria-selected and
// roving tabindex (the active row is the only tab stop).
assert.equal(
  railHtml.match(/aria-selected="true"/g)?.length,
  1,
  'exactly one rail row reports selected',
)
assert.equal(
  railHtml.match(/tabindex="0"/g)?.length,
  1,
  'exactly one rail row is a tab stop (roving focus)',
)
const chatActiveHtml = renderToStaticMarkup(
  <CreationRail models={allModels} mode="chat" onSelect={() => {}} />,
)
assert.match(
  chatActiveHtml,
  /id="creation-tab-chat"[^>]*aria-selected="true"/,
  'the selected rail row follows the active mode',
)

// A registry id outside the bundled set still renders (open WorkspaceMode
// contract) rather than throwing.
const unknownHtml = renderToStaticMarkup(
  <CreationRail
    models={[
      ...allModels,
      {
        id: 'future-plugin-mode',
        label: 'Future',
        description: 'Plugin-contributed mode.',
        icon: allModels[1].icon,
      },
    ]}
    mode="future-plugin-mode"
    onSelect={() => {}}
  />,
)
assert.ok(unknownHtml.includes('Future'), 'unknown registry id renders as a plain rail row')

console.log('creation rail tests passed')
