// Shared UI primitives. Consumed by the Sprint Engine, Automations
// and Review panel rebuilds. Tokens live in
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
export {
  CaptionButton,
  CloseIconButton,
  GhostButton,
  IconButton,
  MediaButton,
  OutlineButton,
  PrimaryButton,
} from './Buttons'
export type {
  ButtonAlign,
  ButtonSize,
  ButtonTone,
  CaptionButtonTone,
  GhostTone,
  IconButtonSize,
} from './Buttons'
// The five shapes the button family was missing (the MC-2118 raw-primitive
// sweep, 2026-09-08). Each is a species, not a restyle: a row, a value row, a
// popover trigger, a tile and a text link answer questions the three sized
// buttons above cannot, and each states why in its own header.
export { RowButton } from './RowButton'
export type { RowButtonDensity, RowButtonProps, RowButtonVariant } from './RowButton'
export { MenuOption } from './MenuOption'
export type { MenuOptionProps, MenuOptionRole } from './MenuOption'
export { TriggerButton } from './TriggerButton'
export type { TriggerButtonProps, TriggerSize, TriggerVariant } from './TriggerButton'
export { CardButton } from './CardButton'
export type { CardButtonProps, CardVariant } from './CardButton'
export { ChipButton } from './ChipButton'
export type { ChipButtonProps, ChipTone, ChipVariant } from './ChipButton'
export { LinkButton } from './LinkButton'
export type { LinkButtonProps, LinkInk, LinkUnderline } from './LinkButton'
export { RefreshIcon } from './RefreshIcon'
export { FileTypeGlyph } from './FileTypeGlyph'
export { ConfirmDialogProvider, useConfirmDialog } from './ConfirmDialog'
export { CliModelPickerButton, CliModelPopoverSurface } from './CliModelPicker'
export type { CliRuntimeOption } from './cliRuntimeCatalog'
export {
  resolveModelPermissionPreset,
  setModelPermissionPreset,
  useModelPermissionPreset,
} from './modelPermissionPresets'
export { Popover } from './Popover'
export { FilterMenu } from './FilterMenu'
export type { FilterMenuGroup } from './FilterMenu'
export type { PopoverProps, PopoverPlacement } from './Popover'
export { useWorkspaceSkills, InlineSkillPicker, SkillPickerPopover } from './SkillPickerPopover'
export type { InlineSkillPickerHandle } from './SkillPickerPopover'
export { OverflowMenu } from './OverflowMenu'
export type { OverflowMenuItem } from './OverflowMenu'
export {
  ContextMenu,
  MenuDivider,
  MenuFlyoutItem,
  MenuItem,
  MenuSwatchRow,
  roveMenuFocus,
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
  MENU_OPTION_CLASS,
  MENU_OPTION_STACKED_CLASS,
  MENU_ROW_CLASS,
  MENU_ROW_HOVER_CLASS,
} from './menuClasses'
export { ProviderRow, ProviderStateId } from './ProviderRow'
export { CliProviderStateLine } from './CliProviderStateLine'
export { resolveCliProviderState } from './cliProviderState'
export { SplitButton } from './SplitButton'
export type { SplitButtonItem } from './SplitButton'
export { PointerPopover } from './PointerPopover'
export { Tabs, TabPanel, TabsScroller } from './Tabs'
export type { TabItem } from './Tabs'
export { TaskCard } from './TaskCard'
export { Switch } from './Switch'
export { Pager } from './Pager'
export { SegmentedControl } from './SegmentedControl'
// The ONE Field. `ui/Modal` used to export a second component under this name —
// a `text-micro` label with no `htmlFor` and no ARIA wiring at all — and both
// arrived through this barrel, so whoever imported "the" Field got a coin flip
// several panel dialogs got the inaccessible one (MC-2114).
export { Field } from './Field'
export { INLINE_TITLE_EDIT_CLASS, Input, Textarea } from './Input'
export type { InputSize, InputVariant } from './Input'
export { Select } from './Select'
export type { SelectItem } from './Select'
export { Checkbox } from './Checkbox'
export { Badge } from './Badge'
export { NewChip } from './NewChip'
export { Table } from './Table'
export { EmptyState } from './EmptyState'
export { SidePane, SidePaneHeader } from './SidePane'
export { BoardLane } from './BoardLane'
export { Banner } from './Banner'
export { ActionResultMessage, InlineNotice } from './InlineNotice'
export type { ActionResult, InlineNoticeTone } from './InlineNotice'
export { Skeleton } from './Skeleton'
export { ChangePulse } from './ChangePulse'
export { LoadingOverlay } from './LoadingOverlay'
export { HtmlPreviewCard } from './HtmlPreviewCard'
export { FilePreviewPane } from './FilePreviewPane'
export { KbdChord } from './KbdChord'
export { RoleGlyph } from './RoleGlyph'
export { StarGlyph } from './StarGlyph'
export { RoleAvatar } from './RoleAvatar'
export { Tooltip } from './Tooltip'
export { TruncatedText } from './TruncatedText'
export type { Tone, StatusTone } from './tokens'
export {
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_CLASS,
  FOCUS_RING_INSET_CLASS,
  FOCUS_RING_WITHIN_INPUT_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  LIST_CURSOR_MARK_CLASS,
  TONE_COLOR_VAR,
  TONE_SOFT_VAR,
} from './tokens'
