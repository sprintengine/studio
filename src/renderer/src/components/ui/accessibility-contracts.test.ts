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
const toast = read('src/renderer/src/components/ui/Toast.tsx')
const tooltip = read('src/renderer/src/components/ui/Tooltip.tsx')
const taskCard = read('src/renderer/src/components/ui/TaskCard.tsx')
const panelHeader = read('src/renderer/src/components/ui/PanelHeader.tsx')
const kbdChord = read('src/renderer/src/components/ui/KbdChord.tsx')
const roleGlyph = read('src/renderer/src/components/ui/RoleGlyph.tsx')
const rendererCss = read('src/renderer/src/assets/index.css')
const switchboardPanel = read('src/renderer/src/components/panels/SwitchboardBoardPanel.tsx')
const watchtowerPanel = [
  read('src/renderer/src/components/panels/WatchtowerPanel.tsx'),
  read('src/renderer/src/components/panels/WatchtowerPanel/ActiveReviewAside.tsx'),
].join('\n')
const sprintEnginePanel = read('src/renderer/src/components/panels/SprintEngineBoardPanel.tsx')
const settingsPanel = read('src/renderer/src/components/settings/SettingsPanel.tsx')
const multiloopSettingsPanel = read('src/renderer/src/components/panels/MultiloopBoardPanel/MultiloopSettingsPopover.tsx')
const sprintEngineSettingsPopover = sliceFunction(sprintEnginePanel, 'SprintEngineSettingsPopover')
const multiloopSettingsPopover = sliceFunction(multiloopSettingsPanel, 'MultiloopSettingsPopover')

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
expectIncludes(popover, 'popover-enter z-50 rounded-[7px]', 'Popover uses the canonical popover shell')
expectIncludes(popover, "window.addEventListener('scroll', reposition, true)", 'Popover tracks its trigger on scroll')
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
  /role=\{checked !== undefined \? 'menuitemcheckbox' : 'menuitem'\}/,
  'MenuItem switches to menuitemcheckbox for checkable items',
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
expectIncludes(contextMenu, 'aria-haspopup="menu"', 'MenuFlyoutItem advertises its nested menu')
expectIncludes(contextMenu, 'aria-expanded={open}', 'MenuFlyoutItem reports flyout expanded state')
expectIncludes(contextMenu, "event.key === 'ArrowRight'", 'MenuFlyoutItem opens its flyout on ArrowRight')
expectIncludes(contextMenu, "event.key === 'ArrowLeft'", 'MenuFlyoutItem flyout closes back to its item on ArrowLeft')
expectIncludes(contextMenu, 'FOCUS_RING_CLASS', 'ContextMenu items apply the shared focus ring class')

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
expectIncludes(sprintEngineSettingsPopover, 'aria-checked={checked}', 'Sprint Engine automation mode radios expose checked state')
assert.ok(
  !/window\.addEventListener\('keydown'/.test(multiloopSettingsPopover),
  'Multiloop settings delegates Escape dismissal to Popover',
)
assert.ok(
  !/window\.addEventListener\('mousedown'/.test(multiloopSettingsPopover),
  'Multiloop settings delegates outside-click dismissal to Popover',
)

// Drawer — right-slide-in primitive with focus trap, ESC close, focus restoration, scroll-lock, reduced-motion.
expectIncludes(drawer, 'role="dialog"', 'Drawer surface exposes the dialog role')
expectIncludes(drawer, 'aria-label={ariaLabel}', 'Drawer requires an accessible name on the dialog surface')
expectIncludes(drawer, 'aria-labelledby={titleId}', 'Drawer wires aria-labelledby to its visible title')
expectIncludes(drawer, "event.key === 'Escape'", 'Drawer closes on Escape')
expectIncludes(drawer, 'event.preventDefault()', 'Drawer cancels default behaviour on Escape to match prior consumer contract')
expectIncludes(drawer, 'restoreFocusRef.current', 'Drawer captures the opener for focus restoration')
expectIncludes(drawer, 'target.focus()', 'Drawer restores focus to the opener on close')
expectIncludes(drawer, "document.body.style.overflow = 'hidden'", 'Drawer locks body scroll while open')
expectIncludes(drawer, 'data-focus-sentinel="true"', 'Drawer installs focus sentinels to trap focus')
expectIncludes(drawer, 'trapFocus', 'Drawer wires a focus trap helper')
expectIncludes(drawer, 'prefersReducedMotion', 'Drawer reads prefers-reduced-motion to skip slide animation')
expectIncludes(drawer, 'drawer-panel', 'Drawer uses the canonical .drawer-panel elevation class')
expectIncludes(rendererCss, '--shadow-drawer:', 'Canonical drawer elevation token is defined in index.css')
expectIncludes(rendererCss, '.drawer-panel', 'Canonical .drawer-panel slide/elevation class is defined in index.css')
expectIncludes(rendererCss, 'box-shadow: var(--shadow-drawer)', '.drawer-panel applies the canonical drawer elevation')

// OnboardingFlow — first-run overlay. Hand-rolls the dialog (not the Modal/Drawer
// primitive) because it renders steps over a real workspace, but it must enforce
// the same keyboard focus trap so a sighted keyboard user cannot Tab into the
// obscured workspace on the first-run step (WCAG 2.4.3). The intentional
// no-Escape / no-backdrop-dismiss behaviour stays: the primary button is the
// only way forward on a fresh install.
const onboardingFlow = read('src/renderer/src/components/onboarding/OnboardingFlow.tsx')
expectIncludes(onboardingFlow, 'role="dialog"', 'OnboardingFlow exposes the dialog role')
expectIncludes(onboardingFlow, 'aria-modal="true"', 'OnboardingFlow marks the overlay modal')
expectIncludes(onboardingFlow, 'aria-labelledby={titleId}', 'OnboardingFlow wires aria-labelledby to its step title')
expectIncludes(onboardingFlow, 'data-focus-sentinel="true"', 'OnboardingFlow installs focus sentinels to trap focus')
expectIncludes(onboardingFlow, 'trapFocus', 'OnboardingFlow wires the focus-trap helper')
expectIncludes(onboardingFlow, "onFocus={trapFocus('start')}", 'OnboardingFlow wraps focus to the last control from the leading sentinel')
expectIncludes(onboardingFlow, "onFocus={trapFocus('end')}", 'OnboardingFlow wraps focus to the first control from the trailing sentinel')
// The first-run step renders over a real workspace whose terminal autofocuses
// AFTER the dialog mounts, so sentinels alone cannot keep focus inside. A
// document focusin guard recovers focus into the dialog when it escapes behind
// the overlay (WCAG 2.4.3).
expectIncludes(onboardingFlow, "addEventListener('focusin'", 'OnboardingFlow installs a document focusin guard to recover focus into the dialog')
expectIncludes(onboardingFlow, 'dialog.contains(target)', 'OnboardingFlow focusin guard only recovers focus when it escapes the dialog')
assert.ok(
  !/event\.key === 'Escape'/.test(onboardingFlow),
  'OnboardingFlow keeps the intentional no-Escape behaviour (no Escape dismiss handler)',
)

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

// WizardProgress — labeled step indicator with optional back-jump. The
// role="progressbar" element is a non-interactive status indicator that
// announces the current step name; the back-jump controls live in a separate
// role="group" layered over the dashes, and are gated to already-completed
// steps via the same isDone state that fills the completed dashes.
const wizardProgress = read('src/renderer/src/components/ui/WizardProgress.tsx')
expectIncludes(wizardProgress, 'role="progressbar"', 'WizardProgress exposes the progressbar role')
expectIncludes(wizardProgress, 'aria-label={fullLabel}', 'WizardProgress announces the current step name via the progressbar label')
expectIncludes(wizardProgress, 'role="group"', 'WizardProgress renders back-jump controls in a separate group, not inside the progressbar')
expectIncludes(wizardProgress, 'idx < doneCount && !isCurrent', 'WizardProgress derives completed-step state (and jump gating) from doneCount, not the raw active index')
assert.ok(
  !/idx < active\b/.test(wizardProgress),
  'WizardProgress does not expose jump controls via idx < active; it gates on the completed-step state',
)
{
  const progressbarIndex = wizardProgress.indexOf('role="progressbar"')
  const groupIndex = wizardProgress.indexOf('role="group"')
  const firstButtonIndex = wizardProgress.indexOf('<button')
  assert.ok(
    progressbarIndex >= 0 && groupIndex > progressbarIndex,
    'WizardProgress declares the progressbar before the interactive back-jump group',
  )
  assert.ok(
    firstButtonIndex > groupIndex,
    'WizardProgress renders back-jump buttons only inside the group, never inside the progressbar element',
  )
}

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
expectIncludes(roleGlyph, 'knowledge/brand/panel-design-system.md', 'RoleGlyph documents itself against the panel design system contract')

expectIncludes(switchboardPanel, '[aria-label="Switchboard overflow"]', 'Switchboard runner restores focus to overflow trigger')
expectMatches(
  watchtowerPanel,
  /(?:aria-label|ariaLabel)="Active review"/,
  'Watchtower active review is a non-modal inline aside, not a Drawer',
)
assert.ok(
  !/<Drawer\b/.test(watchtowerPanel),
  'Watchtower no longer uses the modal Drawer chrome — the active review is an inline aside that joins the flex row',
)
expectIncludes(sprintEnginePanel, '[aria-label^="Run configuration"]', 'Sprint Engine run configuration restores focus to its chip trigger')
expectIncludes(sprintEnginePanel, 'role="tabpanel"', 'Sprint Engine views expose tabpanel semantics')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-inbox"', 'Sprint Engine inbox panel is labelled by its tab')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-roster"', 'Sprint Engine roster panel is labelled by its tab')
expectIncludes(sprintEnginePanel, 'aria-labelledby="sprintengine-view-tab-tasks"', 'Sprint Engine tasks panel is labelled by its tab')

expectIncludes(settingsPanel, 'role="tablist"', 'Settings categories expose tablist semantics')
expectIncludes(settingsPanel, 'role="tabpanel"', 'Settings content exposes tabpanel semantics')
expectIncludes(settingsPanel, 'id="settings-panel-roles"', 'Settings Roles tab has a stable panel id')
expectIncludes(settingsPanel, 'aria-labelledby="settings-tab-roles"', 'Settings Roles panel is labelled by its tab')
expectIncludes(settingsPanel, 'ArrowDown: (index + 1) % visibleSettingsTabs.length', 'Settings category tabs support ArrowDown focus movement')
expectIncludes(settingsPanel, 'ArrowUp: (index - 1 + visibleSettingsTabs.length) % visibleSettingsTabs.length', 'Settings category tabs support ArrowUp focus movement')
expectIncludes(settingsPanel, 'Home: 0', 'Settings category tabs support Home focus movement')
expectIncludes(settingsPanel, 'End: visibleSettingsTabs.length - 1', 'Settings category tabs support End focus movement')
expectIncludes(settingsPanel, 'ariaLabelledBy={switchLabelId}', 'Settings role switches are labelled by visible role names')
expectIncludes(settingsPanel, 'ariaDescribedBy={switchHelpId}', 'Settings role switches describe source and role id context')
expectIncludes(settingsPanel, 'Warning: {warning.message}', 'Settings role warnings include text, not color alone')
expectIncludes(settingsPanel, 'Registry warning: {warning.message}', 'Settings registry warnings include text, not color alone')
expectIncludes(settingsPanel, "roleRegistryStatus === 'loading'", 'Settings Roles distinguishes loading state')
expectIncludes(settingsPanel, "roleRegistryStatus === 'unavailable'", 'Settings Roles distinguishes unavailable state')
expectIncludes(settingsPanel, "roleRegistryStatus === 'ready' && registryRoles.length === 0", 'Settings Roles distinguishes empty state')

expectIncludes(settingsPanel, 'const roleEntries = await window.api.readdir(rolesPath)', 'Settings role install inspects selected registry roles contents')
expectIncludes(settingsPanel, "entry.name.toLowerCase().endsWith('.json')", 'Settings role install filters role manifests to JSON files')
expectIncludes(settingsPanel, 'sourcePath: joinLocalPath(rolesPath, entry.name)', 'Settings role install copies individual role JSON files')
expectIncludes(settingsPanel, "destinationKind: 'roles' as const", 'Settings role install targets discovered manifests at .sprintengine/roles')
expectIncludes(settingsPanel, 'const skillEntries = await window.api.readdir(skillsPath)', 'Settings role install inspects selected registry skills contents')
expectIncludes(settingsPanel, 'sourcePath: joinLocalPath(skillsPath, entry.name)', 'Settings role install copies individual skill folders')
expectIncludes(settingsPanel, "destinationKind: 'skills' as const", 'Settings role install targets discovered skills at .sprintengine/skills')
expectIncludes(settingsPanel, 'await window.api.copyPathInto(target.sourcePath, destinationDir, { overwrite: true })', 'Settings role install preserves resolved child names in registry discovery folders')

console.log('Accessibility primitive contracts passed')
