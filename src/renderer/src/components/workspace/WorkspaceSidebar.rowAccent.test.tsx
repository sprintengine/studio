import assert from 'node:assert/strict'

import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import type { Workspace } from '../../types/workspace'
import { rowAccent } from './WorkspaceSidebar'

function ws(mode: Workspace['mode'], highlight?: Workspace['highlight']): Workspace {
  return { id: 'w', name: 'w', mode, folderPath: null, highlight } as Workspace
}

const allEnabled: ModuleEnablementOverrides = {}

// Enabled bundled modes keep their tool/identity accent (parity).
assert.ok(rowAccent(ws('sprintengine'), allEnabled).border.includes('--tool-sprintengine'), 'enabled sprintengine row keeps its accent border')
assert.ok(rowAccent(ws('sprintengine'), allEnabled).glyph.includes('--tool-sprintengine'), 'enabled sprintengine row keeps its glyph accent')
assert.ok(rowAccent(ws('switchboard'), allEnabled).glyph.includes('--tool-switchboard'), 'enabled switchboard row keeps its glyph accent')
assert.ok(rowAccent(ws('multiloop'), allEnabled).glyph.includes('--tool-multiloop'), 'enabled multiloop row keeps its glyph accent')

// AC4: a disabled module degrades the row to the generic standard accent
// (muted glyph, neutral border) instead of the tool accent.
const seOff = rowAccent(ws('sprintengine'), { 'sprint-engine': false })
assert.ok(seOff.glyph.includes('--text-muted'), 'disabled sprint-engine row uses the muted glyph')
assert.ok(!seOff.glyph.includes('--tool-sprintengine'), 'disabled sprint-engine row drops the tool glyph accent')
assert.ok(seOff.border.includes('--border-strong'), 'disabled sprint-engine row uses the neutral standard border')

const sbOff = rowAccent(ws('switchboard'), { switchboard: false })
assert.ok(sbOff.glyph.includes('--text-muted'), 'disabled switchboard row uses the muted glyph')

const mlOff = rowAccent(ws('multiloop'), { multiloop: false })
assert.ok(mlOff.glyph.includes('--text-muted'), 'disabled multiloop row uses the muted glyph')

// guided-brief is registered under the sprint-engine module, so disabling
// sprint-engine also degrades a guided-brief row.
const gbOff = rowAccent(ws('guided-brief'), { 'sprint-engine': false })
assert.ok(gbOff.glyph.includes('--text-muted'), 'disabling sprint-engine degrades the guided-brief row')

// A highlight color still overrides the row accent regardless of enablement:
// the glyph becomes the highlight hex, not the muted degraded token.
const highlighted = rowAccent(ws('sprintengine', { color: 'blue', starred: false }), { 'sprint-engine': false })
assert.ok(!highlighted.glyph.includes('--text-muted'), 'highlight override is preserved over disabled-module degradation')

console.log('workspace sidebar row accent tests passed')
