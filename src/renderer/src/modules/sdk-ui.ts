// The host half of `@sprintengine/module-sdk/ui` (D6).
//
// A third-party module's renderer bundle marks `@sprintengine/module-sdk/ui`
// external and imports the kit from it; the SDK tarball ships only types and a
// throwing runtime stub, and the real components arrive through the import map
// third-party-loader.ts installs, whose target for that specifier is THIS
// module's namespace. So the module renders with the app's own components,
// against the app's React instance, with no second copy of either.
//
// Why a curated re-export rather than `components/ui/index.ts`: the barrel is
// the app's internal surface and changes freely. This file is a published
// contract — every name here is mirrored in packages/module-sdk/src/ui.ts and
// pinned by the drift guard, so adding or removing one is a deliberate,
// versioned act. Keep the list minimal; a component a single module wants is
// cheaper copied into that module than frozen here forever.
//
// The prop types are derived with `React.ComponentProps` instead of being
// re-exported, because most of the kit declares its props inline or as a
// module-local type. Deriving keeps this file a pure re-export — it must never
// be a reason to widen a component's own exports.
//
// This module is loaded LAZILY (a dynamic import inside
// installSharedRuntimeImportMap) and must stay out of the boot graph: nothing
// eager may import it.

import type * as React from 'react'

export { GhostButton, OutlineButton, PrimaryButton } from '../components/ui/Buttons'
export { Banner } from '../components/ui/Banner'
export { PanelHeader } from '../components/ui/PanelHeader'
export { Drawer } from '../components/ui/Drawer'
export { EmptyState } from '../components/ui/EmptyState'
export { Field } from '../components/ui/Field'
export { Input, Textarea } from '../components/ui/Input'
export { InlineNotice } from '../components/ui/InlineNotice'
export { KbdChord } from '../components/ui/KbdChord'
export { LifecycleGlyph } from '../components/ui/LifecycleGlyph'
export { LinkButton } from '../components/ui/LinkButton'
export { RowButton } from '../components/ui/RowButton'
export { Section } from '../components/ui/Section'
export { SegmentedControl } from '../components/ui/SegmentedControl'
export { Select } from '../components/ui/Select'
export { Spinner } from '../components/ui/Spinner'
export { StatusDot } from '../components/ui/StatusDot'
export { TruncatedText } from '../components/ui/TruncatedText'
export { FOCUS_RING_CLASS } from '../components/ui/tokens'
export { CliModelPickerButton } from '../components/ui/CliModelPicker'

// ── Shared vocabulary ────────────────────────────────────────────────────────

export type { Tone } from '../components/ui/tokens'
export type { LifecycleState } from '../components/ui/LifecycleGlyph'
export type { FilterMenuGroup } from '../components/ui/FilterMenu'
export type { SegmentedControlItem } from '../components/ui/SegmentedControl'
export type { SelectItem } from '../components/ui/Select'

// ── Prop types ───────────────────────────────────────────────────────────────

import type { GhostButton, OutlineButton, PrimaryButton } from '../components/ui/Buttons'
import type { Banner } from '../components/ui/Banner'
import type { PanelHeader } from '../components/ui/PanelHeader'
import type { EmptyState } from '../components/ui/EmptyState'
import type { Field } from '../components/ui/Field'
import type { Input, Textarea } from '../components/ui/Input'
import type { InlineNotice } from '../components/ui/InlineNotice'
import type { KbdChord } from '../components/ui/KbdChord'
import type { LifecycleGlyph } from '../components/ui/LifecycleGlyph'
import type { LinkButton } from '../components/ui/LinkButton'
import type { RowButton } from '../components/ui/RowButton'
import type { Section } from '../components/ui/Section'
import type { SegmentedControl } from '../components/ui/SegmentedControl'
import type { Select } from '../components/ui/Select'
import type { Spinner } from '../components/ui/Spinner'
import type { StatusDot } from '../components/ui/StatusDot'
import type { TruncatedText } from '../components/ui/TruncatedText'
import type { CliModelPickerButton } from '../components/ui/CliModelPicker'

export type { DrawerProps } from '../components/ui/Drawer'

export type GhostButtonProps = React.ComponentProps<typeof GhostButton>
export type OutlineButtonProps = React.ComponentProps<typeof OutlineButton>
export type PrimaryButtonProps = React.ComponentProps<typeof PrimaryButton>
export type BannerProps = React.ComponentProps<typeof Banner>
export type PanelHeaderProps = React.ComponentProps<typeof PanelHeader>
export type EmptyStateProps = React.ComponentProps<typeof EmptyState>
export type FieldProps = React.ComponentProps<typeof Field>
export type InputProps = React.ComponentProps<typeof Input>
export type TextareaProps = React.ComponentProps<typeof Textarea>
export type InlineNoticeProps = React.ComponentProps<typeof InlineNotice>
export type KbdChordProps = React.ComponentProps<typeof KbdChord>
export type LifecycleGlyphProps = React.ComponentProps<typeof LifecycleGlyph>
export type LinkButtonProps = React.ComponentProps<typeof LinkButton>
export type RowButtonProps = React.ComponentProps<typeof RowButton>
export type SectionProps = React.ComponentProps<typeof Section>
export type SegmentedControlProps = React.ComponentProps<typeof SegmentedControl>
export type SelectProps = React.ComponentProps<typeof Select>
export type SpinnerProps = React.ComponentProps<typeof Spinner>
export type StatusDotProps = React.ComponentProps<typeof StatusDot>
export type TruncatedTextProps = React.ComponentProps<typeof TruncatedText>
export type CliModelPickerButtonProps = React.ComponentProps<typeof CliModelPickerButton>
