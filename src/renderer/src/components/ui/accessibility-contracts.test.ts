import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSources(full, out)
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function expectIncludes(source: string, needle: string, message: string): void {
  assert.ok(source.includes(needle), message)
}

function expectMatches(source: string, pattern: RegExp, message: string): void {
  assert.match(source, pattern, message)
}

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`)
  assert.ok(start >= 0, `${name} exists`)
  const candidates = ['\nfunction ', '\nexport default function ', '\n// ='].flatMap((marker) => {
    const index = source.indexOf(marker, start + 1)
    return index >= 0 ? [index] : []
  })
  const next = candidates.length > 0 ? Math.min(...candidates) : -1
  return source.slice(start, next >= 0 ? next : source.length)
}

const overflowMenu = read('src/renderer/src/components/ui/OverflowMenu.tsx')
const popover = read('src/renderer/src/components/ui/Popover.tsx')
const tabs = read('src/renderer/src/components/ui/Tabs.tsx')
const buttons = read('src/renderer/src/components/ui/Buttons.tsx')
const modal = read('src/renderer/src/components/ui/Modal.tsx')
const switchPrimitive = read('src/renderer/src/components/ui/Switch.tsx')
const field = read('src/renderer/src/components/ui/Field.tsx')
const select = read('src/renderer/src/components/ui/Select.tsx')
const drawer = read('src/renderer/src/components/ui/Drawer.tsx')
const focusTrap = read('src/renderer/src/components/ui/FocusTrap.tsx')
const toast = read('src/renderer/src/components/ui/Toast.tsx')
const tooltip = read('src/renderer/src/components/ui/Tooltip.tsx')
const taskCard = read('src/renderer/src/components/ui/TaskCard.tsx')
const panelHeader = read('src/renderer/src/components/ui/PanelHeader.tsx')
const kbdChord = read('src/renderer/src/components/ui/KbdChord.tsx')
const roleGlyph = read('src/renderer/src/components/ui/RoleGlyph.tsx')
const rendererCss = read('src/renderer/src/assets/index.css')
const sprintEnginePanel = read('src/renderer/src/components/panels/SprintEngineBoardPanel.tsx')
const settingsPanel = read('src/renderer/src/components/settings/SettingsPanel.tsx')
const sprintEngineSettingsPopover = sliceFunction(sprintEnginePanel, 'SprintEngineSettingsPopover')

// Popover — shared anchored surface contract for app-shell dropdowns.
expectIncludes(popover, "popupRole: 'menu' | 'listbox' | 'dialog'", 'Popover exposes a thin popup role API')
expectIncludes(popover, "'aria-haspopup'", 'Popover wires aria-haspopup for triggers')
expectIncludes(popover, "'aria-expanded': open", 'Popover wires trigger expanded state')
expectIncludes(popover, "'aria-controls': open ? popoverId : undefined", 'Popover wires trigger controls to a generated surface id')
expectIncludes(popover, 'id={popoverId}', 'Popover assigns the generated id to the surface')
expectIncludes(popover, 'role={popupRole}', 'Popover applies the requested popup role to the surface')
expectIncludes(popover, 'aria-label={ariaLabel}', 'Popover requires an accessible surface name')
expectIncludes(popover, "event.key === 'Escape'", 'Popover closes on Escape')
expectIncludes(popover, 'event.defaultPrevented', 'Popover ignores Escape already handled by nested surfaces')
expectIncludes(popover, 'openPopoverStack', 'Popover tracks nested open surfaces')
expectIncludes(popover, 'isTopmostPopover(popoverId)', 'Popover only lets the topmost open surface handle Escape')
expectIncludes(popover, "window.addEventListener('mousedown'", 'Popover closes on outside pointer down')
expectIncludes(popover, 'triggerRef.current?.focus()', 'Popover restores focus to the trigger on Escape close')
// The surface is portaled to <body> and positioned with fixed coordinates so an
// ancestor's overflow can never clip the menu; placement is computed from the
// trigger rect rather than anchored with absolute classes.
expectIncludes(popover, 'createPortal(', 'Popover portals its surface out of clipping ancestors')
expectIncludes(popover, 'document.body,', 'Popover mounts the surface on document.body')
expectIncludes(popover, "position: 'fixed'", 'Popover anchors the surface with fixed coordinates')
expectIncludes(popover, 'computeSurfacePosition(', 'Popover computes placement from the trigger rect')
// The stacking tier is the token, not the number it happens to equal: MC-2119
// put every overlay layer on `--sem-z-*` (aliased `--z-*`) after Modal's private
// ladder was found sitting a tier BELOW the menus.
// The shell itself is now one constant (MC-2103) — `OVERLAY_SURFACE_CLASS` in
// tokens.ts — because ContextMenu drew a hand-written second copy of it that had
// drifted by a radius, a border token and a ground token. The values it must
// carry are asserted in designSystemAxes.test.ts; what belongs here is that this
// surface still takes its tier from the token and its chrome from the shell.
expectIncludes(
  popover,
  'popover-enter z-[var(--z-popover)]',
  'Popover stacks on the token tier, not on a number that happens to equal it',
)
expectIncludes(popover, 'OVERLAY_SURFACE_CLASS', 'Popover uses the canonical popover shell')
// The handler was named `reposition` until af6585509 renamed it `onScroll`, and
// this assertion kept naming the old one — so it failed, and because verify:app
// is one long `&&` chain it took the 224 steps after it down with it, including
// every card-feed suite. A source-literal assertion is only as good as the
// literal: match the capture, not the handler's name.
expectIncludes(popover, "addEventListener('scroll'", 'Popover tracks its trigger on scroll')
expectIncludes(popover, "removeEventListener('scroll'", 'Popover releases the scroll listener')
expectIncludes(popover, "wantsBottom && surfaceHeight + SURFACE_GAP > spaceBelow", 'Popover flips above the trigger when space is tight')

// ContextMenu — pointer-positioned menu primitive (right-click / kebab-corner
// menus). Unlike Popover it opens at viewport coordinates, so it owns its own
// clamped positioning, dismissal, focus restoration, and roving focus.
const contextMenu = read('src/renderer/src/components/ui/ContextMenu.tsx')
const workspaceSidebar = read('src/renderer/src/components/workspace/WorkspaceSidebar.tsx')

expectIncludes(contextMenu, 'role="menu"', 'ContextMenu surface exposes the menu role')
expectIncludes(contextMenu, 'aria-label={ariaLabel}', 'ContextMenu requires an accessible surface name')
expectMatches(
  contextMenu,
  /role=\{checked !== undefined \? checkableRole : 'menuitem'\}/,
  'MenuItem switches to a checkable role for checkable items',
)
expectMatches(
  contextMenu,
  /selection === 'one-of' \? 'menuitemradio' : 'menuitemcheckbox'/,
  'MenuItem announces a mutually exclusive set as menuitemradio, not independent checkboxes',
)
expectIncludes(contextMenu, 'aria-checked={checked}', 'MenuItem exposes aria-checked for checkable items')
expectIncludes(contextMenu, 'role="separator"', 'MenuDivider exposes the separator role')
expectIncludes(contextMenu, 'role="menuitemradio"', 'MenuSwatchRow swatches expose menuitemradio semantics')
expectIncludes(contextMenu, "event.key === 'Escape'", 'ContextMenu closes on Escape')
expectIncludes(contextMenu, 'event.defaultPrevented', 'ContextMenu ignores Escape already handled by nested surfaces')
expectIncludes(contextMenu, 'previousFocusRef.current?.focus()', 'ContextMenu restores focus to the opener on close')
expectIncludes(contextMenu, "window.addEventListener('pointerdown'", 'ContextMenu closes on outside pointer down')
expectIncludes(contextMenu, "event.key === 'ArrowDown'", 'ContextMenu roves focus on ArrowDown')
expectIncludes(contextMenu, "event.key === 'ArrowUp'", 'ContextMenu roves focus on ArrowUp')
expectIncludes(contextMenu, "event.key === 'Home'", 'ContextMenu roves focus to the first item on Home')
expectIncludes(contextMenu, "event.key === 'End'", 'ContextMenu roves focus to the last item on End')
// The shared permission-preset menu (remote-sessions-ux / selector-menus-
// premium) carries the same keyboard contract as ContextMenu — the launch
// panel's access pill and the chat composer's pill both host it, and both
// hand focus to the checked row on open through the one shared helper.
const presetMenu = read('src/renderer/src/components/workspace/agentComposer/agentSpawnShared.tsx')
expectIncludes(presetMenu, 'role="menuitemradio"', 'preset rows expose menuitemradio semantics')
// The rows are `ui/MenuOption` now, so the checked state travels as `selected`
// and the PRIMITIVE picks the attribute the role takes — `aria-checked` for the
// three checkable roles, `aria-selected` for a listbox option. Emitting the
// wrong one is silent, which is why the mapping is asserted where it lives.
expectIncludes(presetMenu, 'selected={active}', 'the checked preset states it through the row primitive')
const menuOption = read('src/renderer/src/components/ui/MenuOption.tsx')
expectIncludes(
  menuOption,
  'aria-checked={checkable ? selected === true : undefined}',
  'MenuOption emits aria-checked for the checkable roles',
)
expectIncludes(
  menuOption,
  'aria-selected={checkable ? undefined : selected === true}',
  'and aria-selected for a listbox option, never both',
)
expectIncludes(presetMenu, 'tabIndex={active ? 0 : -1}', 'preset rows rove: the checked row is the one tab stop')
expectIncludes(presetMenu, "event.key === 'ArrowDown'", 'preset menu roves focus on ArrowDown')
expectIncludes(presetMenu, "event.key === 'ArrowUp'", 'preset menu roves focus on ArrowUp')
expectIncludes(presetMenu, "event.key === 'Home'", 'preset menu roves focus to the first row on Home')
expectIncludes(presetMenu, "event.key === 'End'", 'preset menu roves focus to the last row on End')
expectIncludes(presetMenu, '.filter(\n    (row) => !row.disabled,\n  )', 'the walk skips disabled rows')
expectIncludes(presetMenu, "event.key === 'Enter' || event.key === ' '", 'Enter and Space activate the focused row')
expectIncludes(presetMenu, 'export function focusActivePresetRow', 'one shared open-focus helper for every host')
const launchPanel = read('src/renderer/src/components/workspace/agentComposer/NewAgentPanel.tsx')
const chatView = read('src/renderer/src/components/panels/AgentChatView.tsx')
// Every spawn surface reaches the preset rows through ONE control now: the
// permission dropdown on the model picker's trailing row (owner, 2026-09-05).
// The launch panel used to open them from a chip of its own, so the open-focus
// contract moved with the control rather than being restated per host.
const spawnFooter = read('src/renderer/src/components/workspace/agentComposer/spawnFooter.tsx')
expectIncludes(spawnFooter, 'onOpenAutoFocus={focusActivePresetRow}', 'the picker dropdown lands focus on the checked preset on open')
expectIncludes(spawnFooter, '<PermissionPresetMenuRows', 'and opens the shared rows, not a second rendering of them')
assert.equal(
  launchPanel.includes('<PermissionPresetMenuRows'),
  false,
  'the launch panel opens the preset rows through that dropdown, never its own copy',
)
expectIncludes(chatView, 'onOpenAutoFocus={focusActivePresetRow}', 'the chat pill lands focus on the checked preset on open')
assert.equal(
  (launchPanel.match(/ role="menu"/g) ?? []).length,
  0,
  'the launch panel nests no second role="menu" inside a Popover surface that already carries it',
)
assert.equal(
  (chatView.match(/ role="menu"/g) ?? []).length,
  0,
  'the chat composer nests no second role="menu" inside a Popover surface that already carries it',
)

expectIncludes(contextMenu, 'aria-haspopup="menu"', 'MenuFlyoutItem advertises its nested menu')
expectIncludes(contextMenu, 'aria-expanded={open}', 'MenuFlyoutItem reports flyout expanded state')
expectIncludes(contextMenu, "event.key === 'ArrowRight'", 'MenuFlyoutItem opens its flyout on ArrowRight')
expectIncludes(contextMenu, "event.key === 'ArrowLeft'", 'MenuFlyoutItem flyout closes back to its item on ArrowLeft')
// The INSET variant specifically (MC-2118's menu unification): menu rows are
// full-bleed to the surface edge now, so an outset ring is clipped by the
// surface border. Still the shared treatment — just the shape that survives
// touching the edge.
//
// It reaches the rows through MENU_ITEM_CLASS (MC-2103) rather than being
// applied host by host, which is why every menu surface is asserted here and not
// just this one: a host that hand-rolls its row is a host that can forget the
// ring, and three of them had.
const menuClasses = read('src/renderer/src/components/ui/menuClasses.ts')
expectIncludes(
  menuClasses,
  'FOCUS_RING_INSET_CLASS',
  'the shared menu item carries the inset focus ring',
)
for (const host of ['ContextMenu', 'OverflowMenu', 'FilterMenu', 'SplitButton']) {
  expectIncludes(
    read(`src/renderer/src/components/ui/${host}.tsx`),
    "from './menuClasses'",
    `${host} rows take the shared focus ring with the rest of the menu canon`,
  )
}

// WorkspaceSidebar consumes the primitive — it must not hand-roll menu chrome.
expectIncludes(workspaceSidebar, '<ContextMenu', 'WorkspaceSidebar menus render through the ui ContextMenu primitive')
expectIncludes(workspaceSidebar, '<MenuSwatchRow', 'WorkspaceSidebar highlight swatch row comes from the primitive')
assert.ok(
  !/role="menu"/.test(workspaceSidebar),
  'WorkspaceSidebar no longer hand-rolls a role="menu" surface',
)
assert.ok(
  !/useClampedMenuPosition/.test(workspaceSidebar),
  'WorkspaceSidebar delegates menu positioning to the ContextMenu primitive',
)

expectIncludes(overflowMenu, 'aria-haspopup="menu"', 'Overflow menu trigger exposes menu semantics')
expectIncludes(overflowMenu, "aria-expanded={triggerProps['aria-expanded']}", 'Overflow menu trigger reports expanded state')
expectIncludes(overflowMenu, 'popupRole="menu"', 'Overflow menu delegates menu role to Popover')
expectIncludes(overflowMenu, 'role="menuitem"', 'Overflow menu actions use menuitem role')
expectIncludes(overflowMenu, '<Popover', 'Overflow menu uses the shared Popover primitive')
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
expectIncludes(modal, '<FocusTrap>', 'Modal traps Tab inside the dialog it declares aria-modal')

expectIncludes(switchPrimitive, 'role="switch"', 'Switch exposes switch role')
expectIncludes(switchPrimitive, 'aria-checked={checked}', 'Switch exposes aria-checked')
expectIncludes(switchPrimitive, "event.key === ' '", 'Switch toggles on Space')
expectMatches(
  switchPrimitive,
  /event\.key === 'Enter'[\s\S]*event\.preventDefault\(\)/,
  'Switch prevents Enter from toggling',
)
expectIncludes(
  switchPrimitive,
  'var(--accent-primary)',
  'Switch uses the accent token for the checked state',
)
expectIncludes(
  switchPrimitive,
  'FOCUS_RING_CLASS',
  'Switch takes the shared focus treatment — no local focus exception survives',
)

expectIncludes(field, 'htmlFor={htmlFor}', 'Field links its <label> to the child input via htmlFor')
expectIncludes(field, "'aria-invalid'", 'Field exposes aria-invalid on the labelled element when an error is set')
expectIncludes(field, "'aria-describedby'", 'Field wires aria-describedby on the labelled element')
expectIncludes(field, 'React.cloneElement', 'Field injects id/ARIA props onto its single child control')

// Select — select-only combobox; ten-line keyboard contract.
expectIncludes(select, 'role="combobox"', 'Select trigger exposes the combobox role')
expectIncludes(select, 'aria-haspopup="listbox"', 'Select trigger advertises a listbox popup')
expectIncludes(select, 'aria-expanded={open}', 'Select trigger reports expanded state')
expectIncludes(select, 'aria-activedescendant={activeOptionId}', 'Select trigger publishes active option id')
expectIncludes(select, 'aria-label={ariaLabel}', 'Select requires an accessible trigger name')
expectIncludes(select, 'popupRole="listbox"', 'Select delegates listbox role to Popover')
expectIncludes(select, 'surfaceAs="ul"', 'Select keeps listbox options inside a list surface')
expectIncludes(select, 'role="option"', 'Select options use the option role')
expectIncludes(select, 'aria-selected={selected}', 'Select options expose aria-selected for the current value')
expectIncludes(select, "event.key === 'ArrowDown'", 'Select supports ArrowDown navigation')
expectIncludes(select, "event.key === 'ArrowUp'", 'Select supports ArrowUp navigation')
expectIncludes(select, "event.key === 'Enter'", 'Select commits on Enter')
expectIncludes(select, "event.key === ' '", 'Select commits on Space')
expectIncludes(select, "event.key === 'Escape'", 'Select closes on Escape')
expectMatches(
  select,
  /event\.key === 'Escape'[\s\S]*event\.preventDefault\(\)/,
  'Select marks Escape handled so an enclosing Popover stays open',
)
expectIncludes(select, 'handleTypeahead', 'Select supports printable-character type-ahead')
expectIncludes(select, 'triggerRef.current?.focus()', 'Select restores focus to the trigger on close')
expectIncludes(select, 'var(--accent-primary)', 'Select uses the accent token for selected state')
assert.ok(
  !/window\.addEventListener\('keydown'/.test(sprintEngineSettingsPopover),
  'Sprint Engine settings delegates Escape dismissal to Popover',
)
assert.ok(
  !/window\.addEventListener\('mousedown'/.test(sprintEngineSettingsPopover),
  'Sprint Engine settings delegates outside-click dismissal to Popover',
)
// Run configuration: the chrome status chip is the popover trigger (one click),
// and the popover's automation modes are a real radio group.
expectIncludes(sprintEnginePanel, 'aria-label={`Run configuration: ${runConfigLabel}`}', 'Run configuration chip names itself and the current run state')
expectIncludes(sprintEnginePanel, 'aria-haspopup="dialog"', 'Run configuration chip advertises its dialog popover')
expectIncludes(sprintEngineSettingsPopover, 'role="radiogroup"', 'Sprint Engine automation modes form a radio group')
// The rows are `ui/MenuOption role="radio"` since MC-2115, and the primitive is
// what emits `aria-checked` for a checkable role (asserted per role in
// buttonSpecies.test.tsx) — so what the panel owes is the state it hands over.
expectIncludes(sprintEngineSettingsPopover, 'selected={checked}', 'Sprint Engine automation mode radios expose checked state')

// Drawer — right-slide-in primitive with focus trap, ESC close, focus restoration, scroll-lock, reduced-motion.
expectIncludes(drawer, 'role="dialog"', 'Drawer surface exposes the dialog role')
expectIncludes(drawer, 'aria-label={ariaLabel}', 'Drawer requires an accessible name on the dialog surface')
expectIncludes(drawer, 'aria-labelledby={titleId}', 'Drawer wires aria-labelledby to its visible title')
expectIncludes(drawer, "event.key === 'Escape'", 'Drawer closes on Escape')
expectIncludes(drawer, 'event.preventDefault()', 'Drawer cancels default behaviour on Escape to match prior consumer contract')
expectIncludes(drawer, 'restoreFocusRef.current', 'Drawer captures the opener for focus restoration')
expectIncludes(drawer, 'target.focus()', 'Drawer restores focus to the opener on close')
expectIncludes(drawer, "document.body.style.overflow = 'hidden'", 'Drawer locks body scroll while open')
expectIncludes(drawer, '<FocusTrap>', 'Drawer traps focus through the shared primitive, not a copy of it')
expectIncludes(focusTrap, 'data-focus-sentinel="true"', 'FocusTrap installs focus sentinels around the trapped region')
expectIncludes(focusTrap, 'startRef.current', 'FocusTrap reads its region from between its own sentinels')
expectIncludes(drawer, 'prefersReducedMotion', 'Drawer reads prefers-reduced-motion to skip slide animation')
expectIncludes(drawer, 'drawer-panel', 'Drawer uses the canonical .drawer-panel elevation class')
expectIncludes(rendererCss, '--shadow-drawer:', 'Canonical drawer elevation token is defined in index.css')
expectIncludes(rendererCss, '.drawer-panel', 'Canonical .drawer-panel slide/elevation class is defined in index.css')
expectIncludes(rendererCss, 'box-shadow: var(--shadow-drawer)', '.drawer-panel applies the canonical drawer elevation')

// FirstRunCliCard — the one surviving first-run question. Deliberately NOT a
// dialog: the onboarding wizard it replaced hand-rolled a modal with a focus
// trap and no Escape, because on a fresh install there was nothing usable behind
// it. There is now — the sidebar, the doors and the workspace all stay live — so
// trapping focus or blocking Escape here would be a WCAG 2.4.3 regression
// dressed up as rigour. It is a card the user may simply ignore, with one
// explicit dismiss.
const firstRunCliCard = read('src/renderer/src/components/onboarding/FirstRunCliCard.tsx')
assert.ok(
  !/role="dialog"/.test(firstRunCliCard),
  'FirstRunCliCard is a card, not a dialog — the app behind it is usable',
)
assert.ok(
  !/aria-modal/.test(firstRunCliCard),
  'FirstRunCliCard never claims to be modal',
)
assert.ok(
  !/data-focus-sentinel/.test(firstRunCliCard) && !/trapFocus/.test(firstRunCliCard),
  'FirstRunCliCard traps no focus: everything behind it stays reachable by keyboard',
)
// The backdrop must not eat clicks meant for the workspace behind it — the card
// itself takes pointer events, the region it centres in does not.
expectIncludes(firstRunCliCard, 'pointer-events-none', 'FirstRunCliCard lets clicks through its centring region')
expectIncludes(firstRunCliCard, 'pointer-events-auto', 'FirstRunCliCard itself is interactive')
expectIncludes(firstRunCliCard, 'Not now', 'FirstRunCliCard offers an explicit dismiss')

// Toast — tone-driven live region. Polite/assertive split keys off StatusDot tones.
expectMatches(toast, /neutral:\s*'status'/, 'Toast routes neutral tone to role="status"')
expectMatches(toast, /good:\s*'status'/, 'Toast routes good tone to role="status"')
expectMatches(toast, /accent:\s*'status'/, 'Toast routes accent tone to role="status"')
expectMatches(toast, /warn:\s*'alert'/, 'Toast routes warn tone to role="alert"')
expectMatches(toast, /error:\s*'alert'/, 'Toast routes error tone to role="alert"')
expectMatches(toast, /neutral:\s*'polite'/, 'Toast neutral uses aria-live="polite"')
expectMatches(toast, /good:\s*'polite'/, 'Toast good uses aria-live="polite"')
expectMatches(toast, /warn:\s*'assertive'/, 'Toast warn uses aria-live="assertive"')
expectMatches(toast, /error:\s*'assertive'/, 'Toast error uses aria-live="assertive"')
expectMatches(toast, /warn:\s*false/, 'Toast disables auto-dismiss for warn tone')
expectMatches(toast, /error:\s*false/, 'Toast disables auto-dismiss for error tone')
expectMatches(toast, /neutral:\s*\d{3,}/, 'Toast auto-dismisses neutral tone after a finite duration')
expectIncludes(toast, 'role={TOAST_ROLE[tone]}', 'Toast surface reads role from the tone map')
expectIncludes(toast, 'aria-live={TOAST_LIVE[tone]}', 'Toast surface reads aria-live from the tone map')
expectIncludes(toast, 'toast-enter', 'Toast uses the shared toast-enter class which is disabled under prefers-reduced-motion')

// Tooltip — Radix-free; hover + focus open, ESC closes, aria-describedby on trigger.
expectIncludes(tooltip, 'role="tooltip"', 'Tooltip surface uses the tooltip role')
expectIncludes(tooltip, "'aria-describedby'", 'Tooltip wires aria-describedby on the trigger')
expectIncludes(tooltip, "event.key === 'Escape'", 'Tooltip closes on Escape')
// A sentence-length tooltip (a full prompt, a path, an error) wraps inside a
// capped measure instead of running off the screen edge. `multiline` REPLACES
// the base `whitespace-nowrap` — appending a competing whitespace utility from
// a caller's `className` is resolved by stylesheet order, not attribute order,
// so the override has to happen where the base is chosen.
expectMatches(
  tooltip,
  /multiline\s*\n?\s*\?\s*'max-w-\[[^']*\]\s+whitespace-pre-wrap[^']*'\s*\n?\s*:\s*'whitespace-nowrap'/,
  'Tooltip swaps its whitespace base for multiline rather than appending one',
)
expectIncludes(tooltip, 'onMouseEnter', 'Tooltip opens on hover')
expectIncludes(tooltip, 'onFocus', 'Tooltip opens on keyboard focus')
expectIncludes(tooltip, 'onBlur', 'Tooltip closes on blur')
expectIncludes(tooltip, 'React.cloneElement', 'Tooltip injects ARIA + handlers onto its single child trigger')
assert.ok(!/\btitle=/.test(tooltip), 'Tooltip does not fall back to the native title attribute')

// TaskCard — shared anatomy across row and card variants. The card is the
// interactive surface only when `onSelect` is provided; otherwise it must not
// steal keyboard focus or expose a button role.
expectIncludes(taskCard, 'data-task-card={variant}', 'TaskCard tags the variant on its root element')
expectIncludes(taskCard, "role={onSelect ? 'button' : undefined}", 'TaskCard exposes role="button" only when interactive')
expectIncludes(taskCard, 'tabIndex={onSelect ? 0 : undefined}', 'TaskCard joins the tab order only when interactive')
expectIncludes(taskCard, 'aria-pressed={onSelect ? selected : undefined}', 'TaskCard reports selection via aria-pressed when interactive')
expectIncludes(taskCard, 'aria-label={ariaLabel}', 'TaskCard accepts an accessible name')
expectIncludes(taskCard, 'onKeyDown={onSelect ? handleKeyDown : undefined}', 'TaskCard only attaches keyboard handler when interactive')
expectMatches(
  taskCard,
  /event\.key === 'Enter' \|\| event\.key === ' '[\s\S]*event\.preventDefault\(\)[\s\S]*onSelect\?\.\(\)/,
  'TaskCard activates on Enter and Space and prevents default scroll',
)
expectIncludes(taskCard, 'FOCUS_RING_CLASS', 'TaskCard applies the shared focus ring class for visible focus')
// Card variant: identifier above title, title clamps to 2 lines.
expectIncludes(taskCard, 'line-clamp-2', 'TaskCard card variant clamps title to two lines for scanability')
// Row variant: identifier inline with title, single-line truncate.
expectIncludes(taskCard, 'truncate', 'TaskCard row variant truncates the title to a single line')
// Identifier semantics — mono + tabular-nums so IDs align in a column.
expectIncludes(taskCard, 'font-mono tabular-nums', 'TaskCard identifier uses mono + tabular-nums for ID columns')

// PanelHeader.progress — 2px hairline overlay. It is a presentational ARIA
// progressbar; it must not steal pointer or keyboard focus, and it is only
// rendered when the panel has a real completion metric.
expectIncludes(panelHeader, 'role="progressbar"', 'PanelHeader.progress exposes the progressbar role')
expectIncludes(panelHeader, 'aria-valuemin={0}', 'PanelHeader.progress declares the progressbar minimum')
expectIncludes(panelHeader, 'aria-valuemax={progress.total}', 'PanelHeader.progress declares the progressbar maximum from total')
expectIncludes(panelHeader, 'aria-valuenow={progress.value}', 'PanelHeader.progress publishes the current value')
expectIncludes(panelHeader, 'aria-label={progress.ariaLabel}', 'PanelHeader.progress accepts an accessible name from the caller')
expectIncludes(panelHeader, 'pointer-events-none', 'PanelHeader.progress hairline does not capture pointer events')
expectIncludes(panelHeader, 'progress && progress.total > 0', 'PanelHeader.progress only renders when the panel has a real completion metric')
assert.ok(
  !/progress[\s\S]*tabIndex=/.test(panelHeader),
  'PanelHeader.progress does not assign a tabIndex (must not steal keyboard focus)',
)

// KbdChord — purely presentational. Each key is a real <kbd> element wearing
// the mono token; the wrapper is role="img" with an accessible name so screen
// readers announce the chord without exposing an interactive role.
expectIncludes(kbdChord, '<kbd ', 'KbdChord renders each key as a real <kbd> element')
expectIncludes(kbdChord, 'role="img"', 'KbdChord exposes role="img" on its wrapper')
expectIncludes(kbdChord, 'aria-label={label}', 'KbdChord exposes an accessible name for the chord')
expectIncludes(kbdChord, 'font-mono', 'KbdChord keys wear the monospace token')
assert.ok(
  !/role="button"|onClick=/.test(kbdChord),
  'KbdChord has no interactive role or click handler',
)

// RoleGlyph — the documented exception to the one-accent rule. Wrapper is
// role="img" with an accessible name including the role label; the tone
// and label both come from the canonical safe accessors (getSprintEngineRoleLabel
// and getSprintEngineRoleAccent) so registry-keyed custom roles render
// safely instead of indexing static bundled-role maps. The documentation
// reference is required in-file.
expectIncludes(roleGlyph, 'role="img"', 'RoleGlyph exposes role="img" on its wrapper')
expectIncludes(roleGlyph, 'aria-label={label}', 'RoleGlyph attaches an accessible name')
expectIncludes(roleGlyph, 'getSprintEngineRoleLabel(role, registry)', 'RoleGlyph names the role via the registry-aware label accessor')
expectIncludes(roleGlyph, 'getSprintEngineRoleAccent(role, registry)', 'RoleGlyph reads tone via the registry-aware accent accessor')
expectIncludes(roleGlyph, 'design-system/foundations/principles.md', 'RoleGlyph documents itself against the design system contract')

expectIncludes(sprintEnginePanel, '[aria-label^="Run configuration"]', 'Sprint Engine run configuration restores focus to its chip trigger')
expectIncludes(sprintEnginePanel, 'role="tabpanel"', 'Sprint Engine views expose tabpanel semantics')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-inbox"', 'Sprint Engine inbox panel is labelled by its tab')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-roster"', 'Sprint Engine roster panel is labelled by its tab')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-tasks"', 'Sprint Engine tasks panel is labelled by its tab')

expectIncludes(settingsPanel, 'role="tablist"', 'Settings categories expose tablist semantics')
expectIncludes(settingsPanel, 'role="tabpanel"', 'Settings content exposes tabpanel semantics')
expectIncludes(settingsPanel, 'ArrowDown: (index + 1) % visibleSettingsTabs.length', 'Settings category tabs support ArrowDown focus movement')
expectIncludes(settingsPanel, 'ArrowUp: (index - 1 + visibleSettingsTabs.length) % visibleSettingsTabs.length', 'Settings category tabs support ArrowUp focus movement')
expectIncludes(settingsPanel, 'Home: 0', 'Settings category tabs support Home focus movement')
expectIncludes(settingsPanel, 'End: visibleSettingsTabs.length - 1', 'Settings category tabs support End focus movement')

// --- The focus indicator (WCAG 2.4.7 / 1.4.11) -------------------------------
//
// One treatment, one declaration, and it has to survive a control whose own fill
// is the focus colour. `--border-focus` and `--accent-primary` resolve to the
// same value in 18 of the 19 themes, so a zero-offset ring on `PrimaryButton` or
// a checked `Switch` had nothing to contrast against and focused rendered
// pixel-identical to unfocused. What separates them now is geometry, not colour:
// the indicator is an outline at a non-zero offset, so it lies wholly outside
// the accent fill against the surface behind it. The chain below is what makes
// that claim checkable — accent-filled control → shared class → one utility →
// outline at a positive offset. The pixels are measured separately, in a browser
// over the real compiled CSS; a class name is not evidence that anything painted.
{
  const tokens = read('src/renderer/src/components/ui/tokens.ts')
  expectMatches(
    tokens,
    /export const FOCUS_RING_CLASS = 'focus-visible:focus-ring'/,
    'FOCUS_RING_CLASS is that utility on :focus-visible — never a width and a colour of its own',
  )
  // Every variant is written out in full rather than assembled from a shared
  // `'focus-ring'` constant. Tailwind v4 generates a rule only for a literal it
  // can see while scanning source and does not evaluate template literals, so an
  // interpolated constant compiles to no CSS and its consumers render with no
  // indicator at all. `peer-focus-visible:` and `has-[input:focus]:` shipped
  // exactly that way and were absent from the built stylesheet (T13,
  // 2026-07-30); the other two survived only because many components also write
  // them literally, which is luck, not a contract.
  for (const [name, literal] of [
    ['FOCUS_RING_CLASS', 'focus-visible:focus-ring'],
    ['FOCUS_RING_INSET_CLASS', 'focus-visible:focus-ring-inset'],
    ['FOCUS_RING_PEER_CLASS', 'peer-focus-visible:focus-ring'],
    ['FOCUS_RING_WITHIN_INPUT_CLASS', 'has-[input:focus]:focus-ring'],
    ['FOCUS_RING_WITHIN_TEXTAREA_CLASS', 'has-[textarea:focus]:focus-ring'],
  ] as const) {
    expectIncludes(
      tokens,
      `export const ${name} = '${literal}'`,
      `${name} is a literal Tailwind can see, not a template literal it cannot`,
    )
  }
  // Assignments only — the comment above the constants quotes the broken form on
  // purpose, and that is documentation, not a declaration.
  assert.ok(
    !/export const FOCUS_RING_[A-Z_]* ?= ?`/.test(tokens),
    'no focus variant is assembled by interpolation — a template literal produces no CSS',
  )

  // The utility, and the values it applies, in assets/index.css.
  expectMatches(
    rendererCss,
    /@utility focus-ring \{\s*outline: var\(--focus-ring\);\s*outline-offset: var\(--focus-ring-offset\);\s*\}/,
    'the focus-ring utility applies --focus-ring as an outline at --focus-ring-offset',
  )
  const outline = /--focus-ring:\s*([^;]+);/.exec(rendererCss)
  assert.ok(outline, '--focus-ring is declared in index.css')
  assert.match(
    outline[1],
    /^2px solid var\(--border-focus\)$/,
    'the indicator is a 2px outline in the theme’s own --border-focus, not a box-shadow ring',
  )
  const offset = /--focus-ring-offset:\s*(\d+(?:\.\d+)?)px;/.exec(rendererCss)
  assert.ok(offset, '--focus-ring-offset is declared in index.css')
  assert.ok(
    Number(offset[1]) > 0,
    `the offset is what separates the indicator from an accent fill, so it must be positive (found ${offset?.[1]}px)`,
  )

  // The accent-filled controls: both take the shared class, so both inherit that
  // offset. PrimaryButton is the most visible case, a checked Switch the one
  // that was measured as pixel-identical before the fix.
  expectMatches(
    buttons,
    /bg-\[color:var\(--accent-primary\)\][\s\S]{0,200}FOCUS_RING_CLASS/,
    'PrimaryButton pairs its accent fill with the shared focus class',
  )
  expectMatches(
    switchPrimitive,
    /bg-\[color:var\(--accent-primary\)\][\s\S]{0,600}FOCUS_RING_CLASS/,
    'a checked Switch pairs its accent track with the shared focus class',
  )

  // The terminal variant (MC-2107). A terminal is the one surface the four
  // above cannot serve — xterm's focused textarea is a descendant, so
  // `:focus-visible` on the canvas never matches, and an outline at the panel
  // edge is clipped by the FlexLayout tab. What makes it a variant rather than a
  // second treatment is that its rule takes the SAME value: `var(--focus-ring)`,
  // not a width and a colour of its own. And it is declared in tokens.ts beside
  // the rest, because a focus class defined privately inside the panel that uses
  // it is how the parallel idiom this sweep retired came to exist.
  expectIncludes(
    tokens,
    "export const FOCUS_RING_TERMINAL_CLASS = 'terminal-focus-ring'",
    'the terminal variant is exported from the token module, not spelled inside a panel',
  )
  expectMatches(
    rendererCss,
    /\.terminal-focus-ring::after \{[^}]*border: var\(--focus-ring\);/,
    'the terminal ring draws the shared --focus-ring value, never one of its own',
  )
  expectMatches(
    rendererCss,
    /\.terminal-focus-ring:focus-within::after/,
    'and lights up on :focus-within, which is what reaches xterm’s own textarea',
  )
  {
    const privateTerminalRing = collectSources(join(root, 'src/renderer/src')).filter((path) => {
      if (/\.test\.tsx?$/.test(path)) return false
      if (/ui[\\/]tokens\.ts$/.test(path)) return false
      return /'terminal-focus-ring'|"terminal-focus-ring"|terminal-focus-ring /.test(
        readFileSync(path, 'utf8'),
      )
    })
    assert.deepEqual(
      privateTerminalRing.map((path) => relative(root, path)),
      [],
      'every terminal reaches the variant through FOCUS_RING_TERMINAL_CLASS, never by writing the class name',
    )
  }

  // And nothing hand-rolls a second treatment. This is the app-wide half of the
  // contract: a per-component ring would drift the moment the shared one moves,
  // which is exactly how the accent collision survived nineteen themes.
  // Focus-scoped only, and over code rather than prose: a selection ring
  // (ContextMenu's chosen swatch, WorkspaceSidebar's drop target) is a different
  // signal that legitimately draws a ring, and tests name class strings to assert
  // on them. Comments are stripped so a note *about* the retired idiom does not
  // read as a use of it.
  const HAND_ROLLED_FOCUS =
    /(?:focus-visible|peer-focus-visible|group-focus-visible|has-\[input:focus\]):(?:ring|outline)-/
  const componentSources = collectSources(join(root, 'src/renderer/src'))
  const offenders = componentSources.filter((path) => {
    if (/\.test\.tsx?$/.test(path)) return false
    const code = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    return HAND_ROLLED_FOCUS.test(code)
  })
  assert.deepEqual(
    offenders.map((path) => relative(root, path)),
    [],
    'no component declares a focus treatment of its own — the utility is the only one',
  )
}

// No renderer surface opens a NATIVE context menu (MC-2104). Four did — the
// editor, the file tree, Git's change rows, and the tab strip — and an OS-drawn
// popup can carry none of the menu contract this file asserts: no role="menu",
// no Escape-restores-focus, no roving focus, no shortcut hints, no destructive
// ink, and metrics and casing owned by the platform rather than by the product.
// The one native menu that survives is the application MENU BAR
// (`src/main/app-menu.ts`), which is the OS's own surface and outside this tree.
//
// The check is on `window.api.showContextMenu`, the only route from the
// renderer to `Menu.popup`. A host that genuinely needs one again has to state
// its reason in design-system/components/menu/component.md and add itself here.
{
  const NATIVE_CONTEXT_MENU = /window\.api\.showContextMenu\s*\(/
  const nativeMenuHosts = collectSources(join(root, 'src/renderer/src')).filter((path) => {
    if (/\.test\.tsx?$/.test(path)) return false
    return NATIVE_CONTEXT_MENU.test(readFileSync(path, 'utf8'))
  })
  assert.deepEqual(
    nativeMenuHosts.map((path) => relative(root, path)),
    [],
    'no renderer surface opens a native context menu — every in-app menu is ContextMenu/MenuItem',
  )
}

// No surface claims modality without trapping the keyboard (MC-2109). Before
// this, not one dialog in the product trapped focus: every overlay did initial
// focus + Escape and then let Tab walk out into the inert page behind the
// scrim, so a keyboard user left the dialog without closing it and started
// operating controls they could not see. `aria-modal="true"` PROMISES assistive
// tech that the page behind is unreachable; `FocusTrap` is what makes the
// promise true, so the two travel together or the claim is a lie.
//
// A surface that genuinely must not trap (a non-modal aside, an in-canvas
// panel) says so by not claiming `aria-modal="true"`. `Drawer` scrims, traps
// and locks scroll, and since 2026-09-02 says so — `aria-modal="true"` — so it
// is covered by this rule like every other dialog rather than exempt from it.
{
  const CLAIMS_MODALITY = /aria-modal=(?:"true"|\{true\})/
  const modalityHosts = collectSources(join(root, 'src/renderer/src')).filter((path) => {
    if (/\.test\.tsx?$/.test(path)) return false
    const code = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    return CLAIMS_MODALITY.test(code) && !/<FocusTrap>/.test(code)
  })
  assert.deepEqual(
    modalityHosts.map((path) => relative(root, path)),
    [],
    'every aria-modal surface mounts the shared FocusTrap — no dialog claims modality it does not deliver',
  )
}

console.log('Accessibility primitive contracts passed')
