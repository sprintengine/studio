import assert from 'node:assert/strict'

import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import type { Workspace } from '../../types/workspace'
import { rowAccent } from './WorkspaceSidebar'

function ws(mode: Workspace['mode'], highlight?: Workspace['highlight']): Workspace {
  return { id: 'w', name: 'w', mode, folderPath: null, highlight } as Workspace
}

const allEnabled: ModuleEnablementOverrides = {}

// Tool identity now rides the glyph alone: selection is a neutral fill, so the
// row carries no identity border for the accent to live on.
assert.ok(rowAccent(ws('sprintengine'), allEnabled).glyph.includes('--tool-sprintengine'), 'enabled sprintengine row keeps its glyph accent')
assert.ok(rowAccent(ws('switchboard'), allEnabled).glyph.includes('--tool-switchboard'), 'enabled switchboard row keeps its glyph accent')
assert.ok(
  !Object.values(rowAccent(ws('sprintengine'), allEnabled)).some((value) => value.includes('border-l-')),
  'no row accent field carries a left bar'
)

// AC4: a disabled module degrades the row to the generic standard accent
// (muted glyph) instead of the tool accent.
const seOff = rowAccent(ws('sprintengine'), { 'sprint-engine': false })
assert.ok(seOff.glyph.includes('--text-muted'), 'disabled sprint-engine row uses the muted glyph')
assert.ok(!seOff.glyph.includes('--tool-sprintengine'), 'disabled sprint-engine row drops the tool glyph accent')

const sbOff = rowAccent(ws('switchboard'), { switchboard: false })
assert.ok(sbOff.glyph.includes('--text-muted'), 'disabled switchboard row uses the muted glyph')

// guided-brief is owned by the design-wizard module (MC-1860), which declares
// dependsOn ['sprint-engine'] — disabling sprint-engine cascades through the
// enablement resolver and still degrades a guided-brief row.
const gbOff = rowAccent(ws('guided-brief'), { 'sprint-engine': false })
assert.ok(gbOff.glyph.includes('--text-muted'), 'disabling sprint-engine degrades the guided-brief row')

// A highlight color still overrides the row accent regardless of enablement:
// the glyph becomes the highlight hex, not the muted degraded token.
const highlighted = rowAccent(ws('sprintengine', { color: 'blue', starred: false }), { 'sprint-engine': false })
assert.ok(!highlighted.glyph.includes('--text-muted'), 'highlight override is preserved over disabled-module degradation')

console.log('workspace sidebar row accent tests passed')
