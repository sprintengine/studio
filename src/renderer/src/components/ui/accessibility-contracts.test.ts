import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function expectIncludes(source: string, needle: string, message: string): void {
  assert.ok(source.includes(needle), message)
}

function expectMatches(source: string, pattern: RegExp, message: string): void {
  assert.match(source, pattern, message)
}

const overflowMenu = read('src/renderer/src/components/ui/OverflowMenu.tsx')
const tabs = read('src/renderer/src/components/ui/Tabs.tsx')
const buttons = read('src/renderer/src/components/ui/Buttons.tsx')
const modal = read('src/renderer/src/components/ui/Modal.tsx')
const switchboardPanel = read('src/renderer/src/components/panels/SwitchboardBoardPanel.tsx')
const watchtowerPanel = read('src/renderer/src/components/panels/WatchtowerPanel.tsx')
const sprintEnginePanel = read('src/renderer/src/components/panels/SprintEngineBoardPanel.tsx')

expectIncludes(overflowMenu, 'aria-haspopup="menu"', 'Overflow menu trigger exposes menu semantics')
expectIncludes(overflowMenu, 'aria-expanded={open}', 'Overflow menu trigger reports expanded state')
expectIncludes(overflowMenu, 'role="menu"', 'Overflow menu surface uses menu role')
expectIncludes(overflowMenu, 'role="menuitem"', 'Overflow menu actions use menuitem role')
expectIncludes(overflowMenu, "event.key === 'Escape'", 'Overflow menu closes on Escape')
expectIncludes(overflowMenu, 'triggerRef.current?.focus()', 'Overflow menu restores focus to trigger on Escape close')
expectIncludes(overflowMenu, "event.key === 'ArrowDown'", 'Overflow menu supports ArrowDown navigation')
expectIncludes(overflowMenu, "event.key === 'ArrowUp'", 'Overflow menu supports ArrowUp navigation')
expectIncludes(overflowMenu, "event.key === 'Home'", 'Overflow menu supports Home navigation')
expectIncludes(overflowMenu, "event.key === 'End'", 'Overflow menu supports End navigation')
expectIncludes(overflowMenu, 'aria-label={ariaLabel}', 'Overflow menu requires an accessible trigger name')

expectIncludes(tabs, 'role="tablist"', 'Tabs expose tablist role')
expectIncludes(tabs, 'role="tab"', 'Tabs expose tab role')
expectIncludes(tabs, 'role="tabpanel"', 'TabPanel exposes tabpanel role')
expectIncludes(tabs, 'aria-controls={panelId}', 'Tabs wire controls to panels')
expectIncludes(tabs, 'aria-labelledby={`${idPrefix}-tab-${tabId}`}', 'TabPanel is labelled by its tab')
expectIncludes(tabs, "event.key === 'ArrowRight'", 'Tabs support ArrowRight navigation')
expectIncludes(tabs, "event.key === 'ArrowLeft'", 'Tabs support ArrowLeft navigation')
expectIncludes(tabs, "event.key === 'Home'", 'Tabs support Home navigation')
expectIncludes(tabs, "event.key === 'End'", 'Tabs support End navigation')
expectIncludes(tabs, 'tab.tabIndex = tab.dataset.tabId === valueRef.current ? 0 : -1', 'Tabs keep a roving tab stop')

expectIncludes(buttons, "'aria-label': string", 'IconButton type requires an accessible name')
expectMatches(buttons, /FOCUS_RING_CLASS[\s\S]*className \?\? ''/, 'Shared buttons apply the focus ring class')
expectIncludes(modal, "event.key === 'Escape'", 'Modal closes on Escape')
expectIncludes(modal, 'previous?.focus()', 'Modal restores focus to the previously active element')

expectIncludes(switchboardPanel, '[aria-label="Switchboard overflow"]', 'Switchboard runner restores focus to overflow trigger')
expectIncludes(watchtowerPanel, '[aria-label="Watchtower overflow"]', 'Watchtower review drawer restores focus to overflow trigger')
expectIncludes(sprintEnginePanel, '[aria-label="Sprint Engine overflow"]', 'Sprint Engine settings restores focus to overflow trigger')
expectIncludes(sprintEnginePanel, 'role="tabpanel"', 'Sprint Engine views expose tabpanel semantics')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-project"', 'Sprint Engine project panel is labelled by its tab')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-task-graph"', 'Sprint Engine task graph panel is labelled by its tab')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-kanban"', 'Sprint Engine kanban panel is labelled by its tab')

console.log('Accessibility primitive contracts passed')
