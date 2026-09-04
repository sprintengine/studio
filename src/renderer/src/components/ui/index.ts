// Shared UI primitives. Consumed by Switchboard, Watchtower,
// and Sprint Engine panel rebuilds. Tokens live in
// src/renderer/src/assets/index.css; tone vocabulary lives in ./tokens.

export { PanelHeader } from './PanelHeader'
export { InboxRow } from './InboxRow'
export { InboxSearchInput } from './InboxSearchInput'
export { Section } from './Section'
export { DefinitionList } from './DefinitionList'
export type { DefinitionItem } from './DefinitionList'
export { StatusDot } from './StatusDot'
export { AgentWorkingDots } from './AgentWorkingDots'
export { Spinner } from './Spinner'
export { LifecycleGlyph, LIFECYCLE_LABEL, type LifecycleState } from './LifecycleGlyph'
export { GhostButton, PrimaryButton, OutlineButton, DangerButton, IconButton, CloseIconButton } from './Buttons'
export { RefreshIcon } from './RefreshIcon'
export { ConfirmDialog, ConfirmDialogProvider, useConfirmDialog } from './ConfirmDialog'
export type { ConfirmDialogOptions, ConfirmDialogProps, PromptDialogOptions } from './ConfirmDialog'
export { CliModelPickerButton, CliModelPopoverSurface, buildModelRows, meaningfulModelId } from './CliModelPicker'
export type { PickerComposition, PickerExtraRow, PickerRailExtra } from './CliModelPicker'
export { ReasoningSelector, costliestReasoningLevel, hasReasoningAxes, reasoningTriggerLabel } from './ReasoningSelector'
export type { ReasoningAxes } from './ReasoningSelector'
export {
  buildModelFamilies,
  familyForModel,
  parseModelWindow,
  windowVariantLabel,
} from './cliRuntimeCatalog'
export type { CliModelFamily, CliRuntimeOption, ModelWindowVariant } from './cliRuntimeCatalog'
export { modelFavouriteKey, parseModelFavouriteKey, toggleModelFavourite, useModelFavourites } from './modelFavourites'
export { Popover } from './Popover'
export { FilterMenu } from './FilterMenu'
export type { FilterMenuGroup } from './FilterMenu'
export type { PopoverProps, PopoverPlacement } from './Popover'
export { useWorkspaceSkills, InlineSkillPicker, SkillPickerPopover } from './SkillPickerPopover'
export type { InlineSkillPickerHandle, SkillPickerPopoverProps } from './SkillPickerPopover'
export { OverflowMenu } from './OverflowMenu'
export type { OverflowMenuItem } from './OverflowMenu'
export {
  ContextMenu,
  MenuDivider,
  MenuFlyoutItem,
  MenuItem,
  MenuSwatchRow,
  roveMenuFocus,
  useClampedMenuPosition,
} from './ContextMenu'
// The menu canon itself, for a surface that must build a menu row the kit does
// not already own. Prefer the components above — a class string is the last
// resort, not the entry point.
export {
  MENU_DIVIDER_CLASS,
  MENU_GROUP_LABEL_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_STACKED_CLASS,
  MENU_LIST_CLASS,
  MENU_ROW_CLASS,
  MENU_SURFACE_CLASS,
} from './menuClasses'
export { ProviderRow, ProviderStateId } from './ProviderRow'
export type { ProviderRowProps } from './ProviderRow'
export { CliProviderStateLine } from './CliProviderStateLine'
export { resolveCliProviderState, cliProviderStateWords } from './cliProviderState'
export type { CliProbeStatus, CliProviderHealth, CliProviderState } from './cliProviderState'
export { SplitButton } from './SplitButton'
export type { SplitButtonItem, SplitButtonProps } from './SplitButton'
export { PointerPopover } from './PointerPopover'
export { Tabs, TabPanel, TabsScroller } from './Tabs'
export type { TabItem } from './Tabs'
export { TaskCard } from './TaskCard'
export type { TaskCardProps, TaskCardVariant } from './TaskCard'
export { Switch } from './Switch'
export { SegmentedControl } from './SegmentedControl'
export type { SegmentedControlItem } from './SegmentedControl'
// The ONE Field. `ui/Modal` used to export a second component under this name —
// a `text-micro` label with no `htmlFor` and no ARIA wiring at all — and both
// arrived through this barrel, so whoever imported "the" Field got a coin flip
// and Watchtower's dialogs got the inaccessible one (MC-2114).
export { Field } from './Field'
export { INLINE_TITLE_EDIT_CLASS, Input, Textarea } from './Input'
export type { InputSize, InputVariant } from './Input'
export { Select } from './Select'
export type { SelectItem } from './Select'
export { Checkbox } from './Checkbox'
export type { CheckboxProps } from './Checkbox'
export { Badge } from './Badge'
export type { BadgeProps, BadgeTone } from './Badge'
export { Table } from './Table'
export type { TableProps, TableCellProps } from './Table'
export { EmptyState } from './EmptyState'
export type { EmptyStateProps } from './EmptyState'
export { Combobox } from './Combobox'
export type { ComboboxOption, ComboboxProps } from './Combobox'
// System vocabulary, not an app screen: the palette is the reference combobox
// (correct `aria-activedescendant` ARIA, which `Combobox` shares bones with) and
// it lived outside the kit, unexported and undocumented (MC-2117). Default
// export kept so `React.lazy(() => import('./ui/CommandPalette'))` still works.
export { default as CommandPalette } from './CommandPalette'
export { Drawer } from './Drawer'
export type { DrawerProps } from './Drawer'
// The one focus trap: every `aria-modal` shell in the renderer wraps its dialog
// element in this, `Modal` included (MC-2109).
export { FocusTrap, FOCUSABLE_SELECTOR } from './FocusTrap'
export { SidePane, SidePaneHeader } from './SidePane'
export { BoardLane, BoardLaneDropIndicator, computeBoardLaneDropIndex } from './BoardLane'
export { Banner } from './Banner'
export type { BannerProps, BannerTone } from './Banner'
export { ActionResultMessage, InlineNotice } from './InlineNotice'
export type { ActionResult, ActionResultTone, InlineNoticeProps, InlineNoticeTone } from './InlineNotice'
export { presentError } from './errorPresentation'
export type { FailureClass, PresentedError, PresentErrorOptions } from './errorPresentation'
export { WizardProgress } from './WizardProgress'
export type { WizardProgressProps } from './WizardProgress'
export { Skeleton } from './Skeleton'
export type { SkeletonProps } from './Skeleton'
export { ChangePulse } from './ChangePulse'
export type { ChangePulseProps } from './ChangePulse'
export { LoadingOverlay } from './LoadingOverlay'
export type { LoadingOverlayProps } from './LoadingOverlay'
export { HtmlPreviewCard, htmlArtifactFrameSandbox } from './HtmlPreviewCard'
export { FilePreviewPane } from './FilePreviewPane'
export { KbdChord } from './KbdChord'
export { RoleGlyph } from './RoleGlyph'
export { StarGlyph } from './StarGlyph'
export { McpGlyph, SkillsGlyph } from './CapabilityGlyphs'
export { RoleAvatar } from './RoleAvatar'
export { Toast } from './Toast'
export { ToastRegion } from './ToastRegion'
export { Tooltip, type TooltipChildProps } from './Tooltip'
export { TruncatedText } from './TruncatedText'
export type { Tone, StatusTone, ToolIdentity } from './tokens'
export {
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_CLASS,
  FOCUS_RING_INSET_CLASS,
  FOCUS_RING_PEER_CLASS,
  FOCUS_RING_WITHIN_INPUT_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  FOCUS_RING_TERMINAL_CLASS,
  LIST_CURSOR_MARK_CLASS,
  TONE_COLOR_VAR,
  STATUS_TONE_COLOR_VAR,
  TONE_SOFT_VAR,
  TOOL_COLOR_VAR,
} from './tokens'
